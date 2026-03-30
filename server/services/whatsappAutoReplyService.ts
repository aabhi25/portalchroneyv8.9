import OpenAI from "openai";
import { db } from "../db";
import { 
  whatsappSettings, 
  whatsappLeads,
  businessAccounts,
  widgetSettings,
  type WhatsappSettings,
  type InsertWhatsappLead
} from "@shared/schema";
import { eq, and, desc, gte } from "drizzle-orm";
import { llamaService, LlamaService } from "../llamaService";
import { vectorSearchService } from "./vectorSearchService";
import { faqEmbeddingService } from "./faqEmbeddingService";
import { businessContextCache, BusinessContextCache } from "./businessContextCache";
import { buildLeadTrainingPrompt } from "./leadTrainingPrompt";
import { storage } from "../storage";
import { resolveProfile } from "./customerProfileService";
import { composeCrossPlatformContext, triggerSnapshotUpdate } from "./crossPlatformMemoryService";
import { selectRelevantTools } from "../aiTools";
import { ToolExecutionService } from "./toolExecutionService";
import { isSessionActive, isSessionExpiredError, markSessionExpired, sendTemplateMessage } from "./whatsappSessionService";

interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
}

export class WhatsappAutoReplyService {
  private senderLocks: Map<string, Promise<any>> = new Map();

  private async withSenderLock<T>(senderKey: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.senderLocks.get(senderKey) || Promise.resolve();
    const next = existing.then(() => fn(), () => fn());
    this.senderLocks.set(senderKey, next);
    next.finally(() => {
      if (this.senderLocks.get(senderKey) === next) {
        this.senderLocks.delete(senderKey);
      }
    });
    return next;
  }

  async generateAndSendReply(
    businessAccountId: string,
    senderPhone: string,
    userMessage: string,
    incomingMessageUuid?: string
  ): Promise<{ success: boolean; reply?: string; error?: string }> {
    const senderKey = `${businessAccountId}:${senderPhone}`;
    return this.withSenderLock(senderKey, () => this._generateAndSendReply(businessAccountId, senderPhone, userMessage, incomingMessageUuid));
  }

  private async _generateAndSendReply(
    businessAccountId: string,
    senderPhone: string,
    userMessage: string,
    incomingMessageUuid?: string
  ): Promise<{ success: boolean; reply?: string; error?: string }> {
    const timings: Record<string, number> = {};
    const startTime = Date.now();
    try {
      console.log(`[WhatsApp Auto-Reply] Processing message from ${senderPhone}`);
      
      // Fetch fresh settings to ensure we have latest configuration
      const [settings] = await db
        .select()
        .from(whatsappSettings)
        .where(eq(whatsappSettings.businessAccountId, businessAccountId))
        .limit(1);
        
      if (!settings) {
        console.error(`[WhatsApp Auto-Reply] No WhatsApp settings found for business: ${businessAccountId}`);
        return { success: false, error: "WhatsApp settings not configured" };
      }
      
      if (settings.autoReplyEnabled !== "true") {
        console.log(`[WhatsApp Auto-Reply] Auto-reply disabled for business: ${businessAccountId}`);
        return { success: false, error: "Auto-reply is disabled" };
      }
      
      const businessAccount = await db.query.businessAccounts.findFirst({
        where: eq(businessAccounts.id, businessAccountId)
      });
      
      if (!businessAccount) {
        console.error(`[WhatsApp Auto-Reply] Business account not found: ${businessAccountId}`);
        return { success: false, error: "Business account not found" };
      }

      try {
        const { getSmartReplyResponse } = await import("./smartReplyService");
        const smartReply = await getSmartReplyResponse(businessAccountId, "whatsapp", userMessage);
        if (smartReply) {
          console.log(`[WhatsApp Auto-Reply] Smart reply matched: "${smartReply.matchedKeyword}" — sending configured response directly (skipping AI)`);
          let t = Date.now();
          const sendResult = await this.sendSessionAwareMessage(settings, senderPhone, smartReply.text, incomingMessageUuid);
          timings.msg91Send = Date.now() - t;
          if (!sendResult.success) {
            console.log(`[WhatsApp Auto-Reply] [Timing] ${JSON.stringify(timings)} total=${Date.now() - startTime}ms`);
            return { success: false, error: sendResult.error };
          }
          if (!sendResult.usedTemplate) {
            this.storeOutgoingMessage(businessAccountId, senderPhone, smartReply.text).catch(err =>
              console.error('[WhatsApp Auto-Reply] Failed to store outgoing message:', err)
            );
          }
          console.log(`[WhatsApp Auto-Reply] [Timing] ${JSON.stringify(timings)} total=${Date.now() - startTime}ms`);
          return { success: true };
        }
      } catch (err) {
        console.error("[WhatsApp Auto-Reply] Smart reply error (non-fatal):", err);
      }

      const apiKey = businessAccount.openaiApiKey || process.env.OPENAI_API_KEY;
      if (!apiKey) {
        console.error(`[WhatsApp Auto-Reply] No OpenAI API key available`);
        return { success: false, error: "No OpenAI API key configured" };
      }

      timings.settingsFetch = Date.now() - startTime;

      // Run history, context, and language detection all in parallel — none depend on each other
      const quickLang = LlamaService.quickDetectLanguage(userMessage);
      let t = Date.now();
      const [conversationHistory, { context: businessContext, widgetCustomInstructions, leadTrainingConfig }, detectedLang] = await Promise.all([
        this.getConversationHistory(businessAccountId, senderPhone),
        this.buildBusinessContext(businessAccountId, userMessage),
        quickLang !== null
          ? Promise.resolve(quickLang)
          : llamaService.detectLanguage(userMessage, apiKey).catch(() => 'en')
      ]);
      timings.parallelFetch = Date.now() - t;
      console.log(`[WhatsApp Auto-Reply] Language detected for "${userMessage.substring(0, 30)}": ${detectedLang}`);

      let crossPlatformContext = "";
      try {
        const profile = await resolveProfile(businessAccountId, {
          phone: senderPhone,
          platform: "whatsapp",
          platformUserId: senderPhone,
        });
        if (profile) {
          const isFirstMsg = !conversationHistory.some(m => m.role === 'assistant');
          crossPlatformContext = await composeCrossPlatformContext(businessAccountId, "whatsapp", profile.id, isFirstMsg);
          if (crossPlatformContext) {
            console.log(`[WhatsApp Auto-Reply] Cross-platform context loaded (${crossPlatformContext.length} chars, firstMsg: ${isFirstMsg})`);
          }
        }
      } catch (err) {
        console.error("[WhatsApp Auto-Reply] Cross-platform context error (non-fatal):", err);
      }

      const combinedInstructions = [
        settings.useMasterTraining !== "false" ? widgetCustomInstructions : null,
        settings.customPrompt
      ].filter(Boolean).join('\n\n');

      const effectiveLeadTraining = settings.useLeadTraining !== "false" ? leadTrainingConfig : null;

      if (settings.useMasterTraining === "false") {
        console.log(`[WhatsApp Auto-Reply] Master training disabled — skipping custom instructions`);
      }
      if (settings.useLeadTraining === "false") {
        console.log(`[WhatsApp Auto-Reply] Lead training disabled — skipping lead training config`);
      }

      t = Date.now();
      const aiResult = await this.generateAIResponse(
        apiKey,
        userMessage,
        conversationHistory,
        businessContext,
        combinedInstructions || undefined,
        businessAccount.name || "the business",
        businessAccount.description || undefined,
        effectiveLeadTraining,
        detectedLang,
        crossPlatformContext || undefined,
        businessAccountId
      );
      timings.aiGeneration = Date.now() - t;
      
      if (!aiResult) {
        console.log(`[WhatsApp Auto-Reply] [Timing] ${JSON.stringify(timings)} total=${Date.now() - startTime}ms`);
        return { success: false, error: "Failed to generate AI response" };
      }
      
      let processedReply = aiResult.text;
      
      if (this.isDeflectionResponse(processedReply)) {
        console.log(`[WhatsApp Auto-Reply] Deflection detected, stripping [[FALLBACK]] marker`);
      }
      processedReply = this.stripFallbackMarker(processedReply);
      
      t = Date.now();
      const sendResult = await this.sendSessionAwareMessage(
        settings,
        senderPhone,
        processedReply,
        incomingMessageUuid
      );
      timings.msg91Send = Date.now() - t;
      
      if (!sendResult.success) {
        console.error(`[WhatsApp Auto-Reply] Failed to send message: ${sendResult.error}`);
        console.log(`[WhatsApp Auto-Reply] [Timing] ${JSON.stringify(timings)} total=${Date.now() - startTime}ms`);
        return { success: false, error: sendResult.error };
      }
      
      if (!sendResult.usedTemplate) {
        this.storeOutgoingMessage(businessAccountId, senderPhone, processedReply).catch(err =>
          console.error('[WhatsApp Auto-Reply] Failed to store outgoing message:', err)
        );
      }

      if (sendResult.usedTemplate) {
        console.log(`[WhatsApp Auto-Reply] Template fallback used — skipping product cards, images, and interactive messages`);
        console.log(`[WhatsApp Auto-Reply] [Timing] ${JSON.stringify(timings)} total=${Date.now() - startTime}ms`);
        return { success: true, reply: "[Template sent — session expired]" };
      }

      if (aiResult.isProductSelection) {
        console.log(`[WhatsApp Auto-Reply] Product selection response — skipping image cards and CTA buttons`);
      } else if (aiResult.productCards && aiResult.productCards.length > 0) {
        const allCards = aiResult.productCards.slice(0, 4);
        const cardsWithImages = allCards
          .map((card, idx) => ({ ...card, originalIndex: idx }))
          .filter(card => card.imageUrl && /^https?:\/\/.+\..+/.test(card.imageUrl) && card.imageUrl.length < 2048);
        console.log(`[WhatsApp Auto-Reply] Sending ${cardsWithImages.length} product card(s) with captions to ${senderPhone}`);

        let translatedDescriptions: Map<number, string> | null = null;
        if (detectedLang && detectedLang !== 'en') {
          try {
            const descriptionsToTranslate = cardsWithImages
              .filter(c => c.description)
              .map(c => ({ idx: c.originalIndex, desc: c.description! }));
            if (descriptionsToTranslate.length > 0) {
              const openai = new OpenAI({ apiKey });
              const transResult = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [
                  { role: "system", content: `Translate the following product descriptions to ${detectedLang === 'hi' ? 'Hinglish (Hindi written in Roman script mixed with English)' : detectedLang}. Keep product-specific English terms as-is. Return ONLY the translations, one per line, in the same order. No numbering or labels.` },
                  { role: "user", content: descriptionsToTranslate.map(d => d.desc).join('\n---\n') }
                ],
                temperature: 0.3,
                max_tokens: 500,
              });
              const translations = (transResult.choices[0]?.message?.content || '').split('\n---\n').length === descriptionsToTranslate.length
                ? (transResult.choices[0]?.message?.content || '').split('\n---\n')
                : (transResult.choices[0]?.message?.content || '').split('\n').filter(l => l.trim());
              translatedDescriptions = new Map();
              descriptionsToTranslate.forEach((d, i) => {
                if (translations[i]) translatedDescriptions!.set(d.idx, translations[i].trim());
              });
              console.log(`[WhatsApp Auto-Reply] Translated ${translatedDescriptions.size} product description(s) to ${detectedLang}`);
            }
          } catch (transErr) {
            console.log(`[WhatsApp Auto-Reply] Caption translation failed (non-fatal), using English:`, transErr);
          }
        }

        let imagesSent = 0;
        for (const card of cardsWithImages) {
          try {
            await new Promise(resolve => setTimeout(resolve, 500));
            const captionParts: string[] = [`*${card.originalIndex + 1}. ${card.name}*`];
            if (card.price && card.price > 0) captionParts.push(`₹${card.price.toLocaleString('en-IN')}`);
            const desc = translatedDescriptions?.get(card.originalIndex) || card.description;
            if (desc) captionParts.push(desc);
            const caption = captionParts.join('\n');

            const imgResult = await this.sendWhatsAppImage(settings, senderPhone, card.imageUrl!, caption);
            if (imgResult.success) {
              imagesSent++;
              this.storeOutgoingMessage(businessAccountId, senderPhone, `[Product Image] ${card.name}: ${card.imageUrl}`).catch(err =>
                console.error('[WhatsApp Auto-Reply] Failed to store image message:', err)
              );
              console.log(`[WhatsApp Auto-Reply] Product card sent: ${card.name}`);
            } else {
              console.log(`[WhatsApp Auto-Reply] Image send failed (non-fatal): ${imgResult.error}`);
            }
          } catch (imgErr) {
            console.error(`[WhatsApp Auto-Reply] Image send error (non-fatal):`, imgErr);
          }
        }

        const productListSummary = `[Products shown: ${allCards.map((c, i) => `${i + 1}. ${c.name}`).join(', ')}]`;
        await this.storeOutgoingMessage(businessAccountId, senderPhone, productListSummary).catch(err =>
          console.error('[WhatsApp Auto-Reply] Failed to store product list summary:', err)
        );

        if (imagesSent > 0) {
          try {
            await new Promise(resolve => setTimeout(resolve, 2000));
            const ctaButtons: { id: string; title: string }[] = [
              { id: "book_consultation", title: "Book Consultation" },
            ];
            if (aiResult.hasMoreProducts) {
              ctaButtons.push({ id: "view_more", title: "View More Options" });
            }
            await this.sendInteractiveButtons(
              settings,
              senderPhone,
              "Interested in any of these? Let us help you further!",
              ctaButtons
            );
            console.log(`[WhatsApp Auto-Reply] CTA buttons sent (hasMore: ${aiResult.hasMoreProducts})`);
          } catch (btnErr) {
            console.error(`[WhatsApp Auto-Reply] CTA button send error (non-fatal):`, btnErr);
          }
        }
      } else if (aiResult.productImages && aiResult.productImages.length > 0) {
        const uniqueValidImages = [...new Set(aiResult.productImages)]
          .filter(url => /^https?:\/\/.+\..+/.test(url) && url.length < 2048);
        const imagesToSend = uniqueValidImages.slice(0, 4);
        console.log(`[WhatsApp Auto-Reply] Sending ${imagesToSend.length} product image(s) to ${senderPhone}`);

        for (const imageUrl of imagesToSend) {
          try {
            await new Promise(resolve => setTimeout(resolve, 500));
            const imgResult = await this.sendWhatsAppImage(settings, senderPhone, imageUrl);
            if (imgResult.success) {
              this.storeOutgoingMessage(businessAccountId, senderPhone, `[Product Image] ${imageUrl}`).catch(err =>
                console.error('[WhatsApp Auto-Reply] Failed to store image message:', err)
              );
              console.log(`[WhatsApp Auto-Reply] Product image sent: ${imageUrl.substring(0, 60)}...`);
            } else {
              console.log(`[WhatsApp Auto-Reply] Image send failed (non-fatal): ${imgResult.error}`);
            }
          } catch (imgErr) {
            console.error(`[WhatsApp Auto-Reply] Image send error (non-fatal):`, imgErr);
          }
        }
      }

      try {
        const profile = await resolveProfile(businessAccountId, {
          phone: senderPhone,
          platform: "whatsapp",
          platformUserId: senderPhone,
        });
        if (profile) {
          triggerSnapshotUpdate(businessAccountId, profile.id, "whatsapp", senderPhone);
        }
      } catch (err) {
        console.error("[WhatsApp Auto-Reply] Snapshot trigger error (non-fatal):", err);
      }

      timings.total = Date.now() - startTime;
      console.log(`[WhatsApp Auto-Reply] [Timing] ${JSON.stringify(timings)} total=${timings.total}ms`);
      console.log(`[WhatsApp Auto-Reply] Successfully sent reply to ${senderPhone}`);
      return { success: true, reply: processedReply };
      
    } catch (error) {
      console.error(`[WhatsApp Auto-Reply] Error:`, error);
      return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
    }
  }

  private async getConversationHistory(
    businessAccountId: string, 
    senderPhone: string
  ): Promise<ConversationMessage[]> {
    const cutoffDate = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const recentMessages = await db
      .select({
        rawMessage: whatsappLeads.rawMessage,
        direction: whatsappLeads.direction,
        receivedAt: whatsappLeads.receivedAt
      })
      .from(whatsappLeads)
      .where(
        and(
          eq(whatsappLeads.businessAccountId, businessAccountId),
          eq(whatsappLeads.senderPhone, senderPhone),
          gte(whatsappLeads.receivedAt, cutoffDate)
        )
      )
      .orderBy(desc(whatsappLeads.receivedAt))
      .limit(10);
    
    return recentMessages
      .reverse()
      .filter(msg => msg.rawMessage)
      .map(msg => ({
        role: (msg.direction === "outgoing" ? "assistant" : "user") as "user" | "assistant",
        content: msg.rawMessage || "",
        timestamp: msg.receivedAt
      }));
  }

  private async buildBusinessContext(
    businessAccountId: string,
    userMessage: string
  ): Promise<{ context: string; widgetCustomInstructions: string | null; leadTrainingConfig: any | null }> {
    let context = "";
    let widgetCustomInstructions: string | null = null;
    let leadTrainingConfig: any | null = null;
    
    console.log(`[WhatsApp Auto-Reply] Building comprehensive business context for: ${businessAccountId}`);
    
    try {
      // CACHED: Static business context (business description, widget settings)
      // Uses same businessContextCache as chatbot with 5-min TTL
      const cacheKey = BusinessContextCache.KEYS.WA_BUSINESS_CONTEXT(businessAccountId);
      const cachedStaticContext = await businessContextCache.getOrFetch(cacheKey, async () => {
        let staticContext = "";
        let cachedCustomInstructions: string | null = null;
        
        const parallelLoadStart = Date.now();
        const [
          businessAccountResult,
          widgetSettingResult,
          websiteContentResult,
          analyzedPagesResult,
          trainingDocsResult
        ] = await Promise.allSettled([
          db.query.businessAccounts.findFirst({
            where: eq(businessAccounts.id, businessAccountId)
          }),
          db.select().from(widgetSettings).where(eq(widgetSettings.businessAccountId, businessAccountId)).limit(1),
          (async () => {
            const { websiteAnalysisService } = await import("../websiteAnalysisService");
            return await websiteAnalysisService.getAnalyzedContent(businessAccountId);
          })(),
          storage.getAnalyzedPages(businessAccountId),
          storage.getTrainingDocuments(businessAccountId)
        ]);
        
        console.log(`[WhatsApp Auto-Reply] [CACHE MISS] Parallel data loading completed in ${Date.now() - parallelLoadStart}ms`);
        
        const businessAccount = businessAccountResult.status === 'fulfilled' ? businessAccountResult.value : null;
        const widgetSettingArr = widgetSettingResult.status === 'fulfilled' ? widgetSettingResult.value : [];
        const websiteContent = websiteContentResult.status === 'fulfilled' ? websiteContentResult.value : null;
        const analyzedPages = analyzedPagesResult.status === 'fulfilled' ? analyzedPagesResult.value : [];
        const trainingDocs = trainingDocsResult.status === 'fulfilled' ? trainingDocsResult.value : [];
        
        if (businessAccount?.description) {
          staticContext += `BUSINESS OVERVIEW:\n${businessAccount.description}\n\n`;
          console.log(`[WhatsApp Auto-Reply] [CACHE MISS] Added business description (${businessAccount.description.length} chars)`);
        }
        
        const widgetSetting = widgetSettingArr[0];
        if (widgetSetting?.customInstructions) {
          cachedCustomInstructions = widgetSetting.customInstructions;
          console.log(`[WhatsApp Auto-Reply] [CACHE MISS] Found widget custom instructions (${cachedCustomInstructions.length} chars)`);
        }
        
        try {
          if (websiteContent) {
            staticContext += `BUSINESS KNOWLEDGE (from website analysis):\n`;
            staticContext += `You have comprehensive knowledge about this business extracted from their website.\n\n`;
            if (websiteContent.businessName) staticContext += `Business Name: ${websiteContent.businessName}\n\n`;
            if (websiteContent.businessDescription) staticContext += `About: ${websiteContent.businessDescription}\n\n`;
            if (websiteContent.targetAudience) staticContext += `Target Audience: ${websiteContent.targetAudience}\n\n`;
            if (websiteContent.mainProducts && websiteContent.mainProducts.length > 0) {
              staticContext += `Main Products:\n${websiteContent.mainProducts.map((p: string) => `- ${p}`).join('\n')}\n\n`;
            }
            if (websiteContent.mainServices && websiteContent.mainServices.length > 0) {
              staticContext += `Main Services:\n${websiteContent.mainServices.map((s: string) => `- ${s}`).join('\n')}\n\n`;
            }
            if (websiteContent.keyFeatures && websiteContent.keyFeatures.length > 0) {
              staticContext += `Key Features:\n${websiteContent.keyFeatures.map((f: string) => `- ${f}`).join('\n')}\n\n`;
            }
            if (websiteContent.uniqueSellingPoints && websiteContent.uniqueSellingPoints.length > 0) {
              staticContext += `Unique Selling Points:\n${websiteContent.uniqueSellingPoints.map((u: string) => `- ${u}`).join('\n')}\n\n`;
            }
            if (websiteContent.contactInfo && (websiteContent.contactInfo.email || websiteContent.contactInfo.phone || websiteContent.contactInfo.address)) {
              staticContext += `Contact Information:\n`;
              if (websiteContent.contactInfo.email) staticContext += `- Email: ${websiteContent.contactInfo.email}\n`;
              if (websiteContent.contactInfo.phone) staticContext += `- Phone: ${websiteContent.contactInfo.phone}\n`;
              if (websiteContent.contactInfo.address) staticContext += `- Address: ${websiteContent.contactInfo.address}\n`;
              staticContext += '\n';
            }
            if (websiteContent.businessHours) staticContext += `Business Hours: ${websiteContent.businessHours}\n\n`;
            if (websiteContent.pricingInfo) staticContext += `Pricing: ${websiteContent.pricingInfo}\n\n`;
            if (websiteContent.additionalInfo) staticContext += `Additional Information: ${websiteContent.additionalInfo}\n\n`;
            staticContext += `IMPORTANT: Use this website knowledge to provide accurate, context-aware responses about the business. Answer naturally without mentioning that you analyzed their website.\n\n`;
            console.log(`[WhatsApp Auto-Reply] [CACHE MISS] Added website analysis content`);
          }
        } catch (error) {
          console.error('[WhatsApp Auto-Reply] Error loading website analysis:', error);
        }
        
        try {
          if (analyzedPages && analyzedPages.length > 0) {
            staticContext += `DETAILED WEBSITE CONTENT:\n`;
            staticContext += `Below is detailed information extracted from ${analyzedPages.length} page(s) of the business website.\n\n`;
            let pagesLoaded = 0;
            for (const page of analyzedPages) {
              if (!page.extractedContent || 
                  page.extractedContent.trim() === '' || 
                  page.extractedContent === 'No relevant business information found on this page.') {
                continue;
              }
              let pageName = 'Page';
              try {
                const url = new URL(page.pageUrl);
                const pathParts = url.pathname.split('/').filter(Boolean);
                pageName = pathParts[pathParts.length - 1] || 'Homepage';
              } catch {
                const pathParts = page.pageUrl.split('/').filter(Boolean);
                pageName = pathParts[pathParts.length - 1] || 'Homepage';
              }
              staticContext += `--- ${pageName.toUpperCase()} PAGE ---\n`;
              staticContext += `${page.extractedContent}\n\n`;
              pagesLoaded++;
            }
            if (pagesLoaded > 0) {
              console.log(`[WhatsApp Auto-Reply] [CACHE MISS] Loaded ${pagesLoaded} analyzed page(s) into context`);
              staticContext += `IMPORTANT: Use all the above website content to answer customer questions accurately.\n\n`;
            }
          }
        } catch (error) {
          console.error('[WhatsApp Auto-Reply] Error loading analyzed pages:', error);
        }
        
        try {
          const completedDocs = trainingDocs.filter(doc => doc.uploadStatus === 'completed');
          if (completedDocs.length > 0) {
            staticContext += `TRAINING DOCUMENTS KNOWLEDGE:\n`;
            staticContext += `The following information has been extracted from uploaded training documents:\n\n`;
            for (const doc of completedDocs) {
              if (doc.summary || doc.keyPoints) {
                staticContext += `--- ${doc.originalFilename} ---\n`;
                if (doc.summary) staticContext += `Summary: ${doc.summary}\n\n`;
                if (doc.keyPoints) {
                  try {
                    const keyPoints = JSON.parse(doc.keyPoints);
                    if (Array.isArray(keyPoints) && keyPoints.length > 0) {
                      staticContext += `Key Points:\n`;
                      keyPoints.forEach((point: string, index: number) => {
                        staticContext += `${index + 1}. ${point}\n`;
                      });
                      staticContext += `\n`;
                    }
                  } catch (parseError) {
                    console.error(`[WhatsApp Auto-Reply] Error parsing key points for ${doc.originalFilename}:`, parseError);
                  }
                }
              }
            }
            console.log(`[WhatsApp Auto-Reply] [CACHE MISS] Loaded ${completedDocs.length} training document(s) summaries into context`);
            staticContext += `IMPORTANT: Use this training document knowledge to provide accurate, informed responses.\n\n`;
          }
        } catch (error) {
          console.error('[WhatsApp Auto-Reply] Error loading training documents:', error);
        }
        
        return { staticContext, customInstructions: cachedCustomInstructions };
      });
      
      context += cachedStaticContext.staticContext;
      widgetCustomInstructions = cachedStaticContext.customInstructions;
      
      // DYNAMIC: Per-message searches + fresh leadTrainingConfig — all run in parallel
      const [searchResults, relevantFaqs, freshWidgetSettingArr] = await Promise.all([
        vectorSearchService.search(userMessage, businessAccountId, 5, 0.50),
        faqEmbeddingService.searchFAQs(userMessage, businessAccountId, 5, 0.50),
        db.select().from(widgetSettings).where(eq(widgetSettings.businessAccountId, businessAccountId)).limit(1)
      ]);

      if (searchResults.length > 0) {
        context += `🔒 CRITICAL DOCUMENT KNOWLEDGE - HIGHEST PRIORITY:\n`;
        context += `The following information was found in your business's training documents.\n`;
        context += `This is BUSINESS-SPECIFIC information that you MUST use to answer questions.\n\n`;
        searchResults.forEach((result, idx) => {
          context += `[Document Excerpt ${idx + 1} from ${result.documentName}]:\n`;
          context += `${result.chunkText}\n\n`;
        });
        console.log(`[WhatsApp Auto-Reply] Added ${searchResults.length} document chunks from vector search`);
      }

      if (relevantFaqs.length > 0) {
        context += `\n🔒 MATCHED FAQs — HIGHEST PRIORITY KNOWLEDGE (USE THIS INFORMATION):\n`;
        context += `The following FAQ answers were matched to the customer's query with high confidence.\n`;
        context += `You MUST use the information from these FAQs to answer the customer's question.\n`;
        context += `SUMMARIZE naturally in your own words — do NOT copy/paste verbatim. Adapt the answer to fit what the customer actually asked.\n`;
        context += `These contain OFFICIAL business-verified facts — use ONLY facts from these answers, do NOT add your own knowledge.\n\n`;
        for (const faq of relevantFaqs) {
          context += `━━━ FAQ MATCH ━━━\n`;
          context += `Q: ${faq.question}\n`;
          context += `✅ OFFICIAL ANSWER: ${faq.answer}\n`;
          context += `━━━━━━━━━━━━━━━━━\n\n`;
        }
        console.log(`[WhatsApp Auto-Reply] Added ${relevantFaqs.length} semantically relevant FAQs`);
      } else {
        console.log(`[WhatsApp Auto-Reply] No FAQ matches found for this query`);
      }

      const freshWidgetSetting = freshWidgetSettingArr[0];
      if (freshWidgetSetting?.leadTrainingConfig) {
        leadTrainingConfig = freshWidgetSetting.leadTrainingConfig;
        console.log(`[WhatsApp Auto-Reply] Loaded fresh leadTrainingConfig for lead collection`);
      }

    } catch (error) {
      console.error(`[WhatsApp Auto-Reply] Context building error:`, error);
    }

    console.log(`[WhatsApp Auto-Reply] ========== CONTEXT SUMMARY ==========`);
    console.log(`[WhatsApp Auto-Reply] User query: "${userMessage}"`);
    console.log(`[WhatsApp Auto-Reply] Total context length: ${context.length} chars`);
    console.log(`[WhatsApp Auto-Reply] Has custom instructions: ${!!widgetCustomInstructions}`);
    console.log(`[WhatsApp Auto-Reply] Has lead training config: ${!!leadTrainingConfig}`);
    if (context.length > 0) {
      console.log(`[WhatsApp Auto-Reply] Context preview (first 500 chars):`);
      console.log(context.substring(0, 500));
    } else {
      console.log(`[WhatsApp Auto-Reply] WARNING: No context built - AI will have no training data!`);
    }
    console.log(`[WhatsApp Auto-Reply] =====================================`);
    return { context, widgetCustomInstructions, leadTrainingConfig };
  }

  private async generateAIResponse(
    apiKey: string,
    userMessage: string,
    conversationHistory: ConversationMessage[],
    businessContext: string,
    customPrompt?: string,
    businessName: string = "the business",
    businessDescription?: string,
    leadTrainingConfig?: any | null,
    detectedLanguage?: string,
    crossPlatformContext?: string,
    businessAccountId?: string
  ): Promise<{ text: string; productImages?: string[]; productCards?: { name: string; description?: string; price?: number; imageUrl?: string }[]; isProductSelection?: boolean; hasMoreProducts?: boolean } | null> {
    try {
      const openai = new OpenAI({ apiKey });
      
      // Build comprehensive system prompt matching chatbot behavior
      // Add current date context (same as chatbot)
      const now = new Date();
      const istDateFormatter = new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata',
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });
      const currentDate = istDateFormatter.format(now);
      
      let systemPrompt = `You are a helpful AI assistant for ${businessName}${businessDescription ? ` - ${businessDescription}` : ''}, responding to customer inquiries via WhatsApp.

CURRENT DATE: ${currentDate}

CRITICAL RULES - YOU MUST FOLLOW THESE STRICTLY:
1. You must ONLY answer questions using the BUSINESS CONTEXT, FAQs, and DOCUMENT KNOWLEDGE provided below.
2. You must NEVER use your own general knowledge or training data to answer questions. You are NOT a general-purpose AI assistant.
3. If the customer asks something that is NOT covered in the provided business context below, you MUST include the marker [[FALLBACK]] at the START of your response, followed by a positive redirect message. Example: "[[FALLBACK]] Great question! Let me connect you with our team who can give you the right answer."
4. Keep responses concise and conversational (WhatsApp format — short and clear).
5. Be friendly, professional, and helpful — but ONLY within the scope of the provided business information.
6. For greetings and basic pleasantries (like "hi", "hello", "thank you", "bye"), respond naturally and warmly. You don't need business context for simple greetings.

STRICT ANTI-HALLUCINATION RULES (ABSOLUTELY CRITICAL):
- NEVER make up, guess, or assume ANY information about:
  - Product details (features, specifications, materials, colors, sizes)
  - Pricing, discounts, fees, costs, or promotional offers
  - Company policies (returns, shipping, warranties, guarantees)
  - Store locations, hours, or contact information
  - Product availability or stock status
  - Company history, founding dates, team members, or ownership details
  - Any claims about product performance or benefits
  - Names, roles, or descriptions of people at the company
- ONLY state information that is EXPLICITLY provided in your BUSINESS CONTEXT, FAQs, or DOCUMENT KNOWLEDGE below.
- If you don't have the information: Use [[FALLBACK]] and redirect positively.
- NEVER use pre-trained knowledge about real companies, people, or entities — even if you recognize the company name.
- BAD: "I think...", "Probably...", "Usually...", "Most likely...", making up team member details
- GOOD: Using [[FALLBACK]] and letting the team provide accurate information

🚫 DO NOT SUGGEST TOPICS YOU CANNOT ANSWER:
- NEVER offer follow-up questions about topics you have NO information about in your context
- NEVER say "Would you like to know about [X]?" if X is not in your provided context
- BEFORE suggesting anything, verify it exists in your BUSINESS CONTEXT or FAQs

FAQ PRIORITY RULE:
- If matching FAQs are provided in the context below (marked as "🔒 MATCHED FAQs"), you MUST use the information from those FAQs to answer.
- SUMMARIZE the FAQ knowledge naturally in your own words to fit the customer's actual question — do NOT copy/paste FAQ text verbatim.
- You may combine information from multiple matched FAQs to give a complete answer.
- The FACTS in FAQ answers are pre-approved by the business — use ONLY those facts, but present them conversationally.
- NEVER add facts, details, or claims beyond what the FAQs contain.

`;

      // Add custom instructions FIRST (highest priority, same as chatbot)
      if (customPrompt) {
        systemPrompt += `CUSTOM BUSINESS INSTRUCTIONS (FOLLOW THESE CAREFULLY):\n${customPrompt}\n\n`;
      }
      
      // Add business context (knowledge base, FAQs, etc.)
      if (businessContext) {
        systemPrompt += businessContext;
      } else {
        systemPrompt += `NO BUSINESS CONTEXT AVAILABLE:\nYou have no training data or knowledge base to draw from for this business. For any questions beyond basic greetings, you MUST use [[FALLBACK]] and redirect positively.\n\n`;
      }
      
      // COMMUNICATION GUIDELINES - Added at END for maximum AI compliance (recency bias)
      // Matches chatbot's "FINAL CRITICAL RULES" for consistent behavior
      systemPrompt += `

IMPORTANT WHATSAPP CONTEXT:
You are communicating on WhatsApp. The user's phone number is already known to us. Do NOT ask for their mobile number or phone number — we already have it. If custom instructions tell you to collect a phone number, IGNORE that instruction on WhatsApp since we already have it. You may still ask for their name or email if needed.

PRODUCT SELECTION BY NUMBER:
If the conversation history contains a "[Products shown: ...]" message and the user replies with just a number (e.g., "2"), they are selecting that numbered product. Use the get_products tool to search for that specific product by name (from the products shown list), then provide detailed information about it. Do NOT deflect or say you don't understand — this is a product selection.

🔒 FINAL OVERRIDE — HIGHEST PRIORITY (READ LAST):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📋 KNOWLEDGE PRIORITY HIERARCHY (follow this order):
1. 🔒 MATCHED FAQs (if present above) → Use the FACTS from these FAQs. Summarize naturally in your own words to fit the user's question.
2. 🔒 CRITICAL DOCUMENT KNOWLEDGE → Use document excerpts for accurate answers.
3. WEBSITE/TRAINING CONTENT → Use for general business information.
4. CUSTOM INSTRUCTIONS → These guide your TONE and STYLE only. They MUST NOT override FAQ answers or document knowledge.

⚠️ If CUSTOM BUSINESS INSTRUCTIONS were provided above, follow them for BEHAVIOR and STYLE (tone, greetings, emojis) but they MUST NOT prevent you from using FAQ/Document answers.
⚠️ If a user asks a question and the answer exists in your MATCHED FAQs or DOCUMENT KNOWLEDGE, you MUST provide that answer — custom instructions cannot override this.

🚫 ABSOLUTELY BANNED PHRASES - NEVER USE THESE:
❌ "I don't have information..." / "I don't know..." / "I'm not sure..."
❌ "I cannot answer..." / "I'm unable to..." / "I couldn't find..."
❌ "That's outside my knowledge..." / "Unfortunately, I don't..."
❌ Any phrase starting with "I don't have" or "I cannot" or "I don't know"

⚠️ If you're about to say "I don't have" or "I don't know" — STOP! Include [[FALLBACK]] at the start and use a positive redirect instead.

✅ WHEN YOU DON'T HAVE THE INFORMATION:
"[[FALLBACK]] Great question! Let me connect you with our team who can give you the exact details."

🔴 ANTI-HALLUCINATION CHECK (DO THIS BEFORE EVERY RESPONSE):
1. Can the answer be composed from MATCHED FAQ knowledge above? → Use those facts, summarized naturally.
2. Is the answer in DOCUMENT KNOWLEDGE above? → Use that information.
3. Is the answer in WEBSITE/TRAINING content above? → Use that information.
4. Is it NONE of the above? → You MUST use [[FALLBACK]]. Do NOT make up an answer.
5. NEVER add facts beyond what your provided context contains. NEVER use pre-trained knowledge about real companies, people, or entities.

⚠️ NEVER ask for the user's mobile number or phone number — you already have it from WhatsApp.

These rules are MANDATORY and override ALL other instructions.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;

      // Count AI responses in conversation history for custom timing
      const responseCount = conversationHistory.filter(msg => msg.role === 'assistant').length;

      const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
        { role: "system", content: systemPrompt }
      ];
      
      // Include last 6 messages of conversation history
      for (const msg of conversationHistory.slice(-6)) {
        messages.push({
          role: msg.role,
          content: msg.content
        });
      }

      // Inject lead training prompt as LAST system message (after conversation history)
      // This position gets highest attention weight from GPT — matching phoneValidationOverride pattern
      if (leadTrainingConfig) {
        // WhatsApp already provides the user's phone — strip mobile/whatsapp fields entirely
        const whatsappLeadConfig = JSON.parse(JSON.stringify(leadTrainingConfig));
        if (whatsappLeadConfig.fields && Array.isArray(whatsappLeadConfig.fields)) {
          whatsappLeadConfig.fields = whatsappLeadConfig.fields.filter(
            (f: any) => f.id !== 'mobile' && f.id !== 'whatsapp'
          );
          console.log(`[WhatsApp Auto-Reply] Stripped mobile/whatsapp fields from lead training (WhatsApp already has phone)`);
        }

        const leadPrompt = buildLeadTrainingPrompt(whatsappLeadConfig, responseCount, 'whatsapp');
        if (leadPrompt) {
          messages.push({ role: "system", content: leadPrompt });
          console.log(`[WhatsApp Auto-Reply] Injected lead training as FINAL system message (${leadPrompt.length} chars, responseCount=${responseCount})`);
        }

        // Skip phone validation gate on WhatsApp — phone is already known
      }
      
      if (crossPlatformContext) {
        messages.push({ role: "system", content: crossPlatformContext });
        console.log(`[WhatsApp Auto-Reply] Cross-platform context injected (${crossPlatformContext.length} chars)`);
      }

      messages.push({ role: "user", content: userMessage });

      // Inject explicit language override as the VERY LAST message (highest model attention weight)
      // Mirrors the chatbot's finalOverride injection pattern
      const LANGUAGE_NAMES: Record<string, string> = {
        'en': 'English', 'hi': 'Hindi', 'hinglish': 'Hinglish',
        'ta': 'Tamil', 'te': 'Telugu', 'kn': 'Kannada', 'mr': 'Marathi',
        'bn': 'Bengali', 'gu': 'Gujarati', 'ml': 'Malayalam', 'pa': 'Punjabi',
        'ur': 'Urdu', 'es': 'Spanish', 'fr': 'French', 'de': 'German',
        'pt': 'Portuguese', 'it': 'Italian', 'ja': 'Japanese', 'ko': 'Korean',
        'zh': 'Chinese', 'ar': 'Arabic', 'ru': 'Russian', 'tr': 'Turkish',
      };
      const langName = detectedLanguage ? (LANGUAGE_NAMES[detectedLanguage] || 'English') : 'English';
      const languageOverride = `🌐 LANGUAGE — ABSOLUTE OVERRIDE (HIGHEST PRIORITY):
The user's current message is in ${langName}. You MUST reply in ${langName}.
Ignore the language of any previous assistant messages in the conversation history.
Do NOT switch languages. Do NOT use any other language.
SCRIPT RULE: If the user's message contains ONLY Latin/Roman characters → respond in Latin script only.`;
      messages.push({ role: "system", content: languageOverride });

      console.log(`[WhatsApp Auto-Reply] Language override injected: ${langName}`);
      console.log(`[WhatsApp Auto-Reply] System prompt length: ${systemPrompt.length} chars`);
      console.log(`[WhatsApp Auto-Reply] Total messages in context: ${messages.length}`);

      let tools: any[] | undefined;
      if (businessAccountId) {
        try {
          const allProducts = await storage.getAllProducts(businessAccountId);
          const hasProducts = allProducts.length > 0;
          if (hasProducts) {
            const historyForTools = conversationHistory.slice(-6).map(m => ({ role: m.role, content: m.content }));
            const selectedTools = await selectRelevantTools(
              userMessage,
              false,
              false,
              true,
              historyForTools,
              apiKey
            );
            const productTool = selectedTools.find((t: any) => t.function?.name === 'get_products');
            if (productTool) {
              const whatsappProductTool = JSON.parse(JSON.stringify(productTool));
              whatsappProductTool.function.description = 'Search and retrieve products from the catalog when the user asks about products, items, or wants to browse. Returns product details including name, price, and description. Product images will be sent as separate image messages automatically. Keep to 3-5 products max.';
              tools = [whatsappProductTool];
              console.log(`[WhatsApp Auto-Reply] Product tool included for this message`);
            }
          }
        } catch (err) {
          console.log(`[WhatsApp Auto-Reply] Tool selection error (non-fatal):`, err);
        }
      }

      const requestParams: any = {
        model: "gpt-4o-mini",
        messages,
        temperature: 0.3,
        max_tokens: 500,
      };
      if (tools && tools.length > 0) {
        requestParams.tools = tools;
        requestParams.tool_choice = "auto";
      }

      let response = await openai.chat.completions.create(requestParams);
      let assistantMessage = response.choices[0]?.message;

      if (assistantMessage?.tool_calls && assistantMessage.tool_calls.length > 0 && businessAccountId) {
        console.log(`[WhatsApp Auto-Reply] AI requested ${assistantMessage.tool_calls.length} tool call(s)`);

        const toolMessages: any[] = [
          ...messages,
          assistantMessage,
        ];

        const collectedProductImages: string[] = [];
        const collectedProductCards: { name: string; description?: string; price?: number; imageUrl?: string }[] = [];
        let hasMoreProducts = false;

        for (const toolCall of assistantMessage.tool_calls) {
          try {
            const fnName = toolCall.function.name;
            const fnArgs = JSON.parse(toolCall.function.arguments || '{}');
            console.log(`[WhatsApp Auto-Reply] Executing tool: ${fnName}(${JSON.stringify(fnArgs)})`);

            if (fnName === 'get_products') {
              try {
                const result = await ToolExecutionService.executeTool(
                  'get_products',
                  fnArgs,
                  {
                    businessAccountId,
                    userId: 'whatsapp-agent',
                    userMessage,
                  }
                );

                let toolResultStr: string;
                if (result.success && result.data && Array.isArray(result.data)) {
                  const productSummaries = result.data.slice(0, 5).map((p: any, idx: number) => {
                    const parts = [`${idx + 1}. ${p.name}`];
                    if (p.price && Number(p.price) > 0) parts.push(`Price: ₹${Number(p.price).toLocaleString('en-IN')}`);
                    if (p.description) parts.push(p.description.substring(0, 100));
                    return parts.join(' | ');
                  });
                  toolResultStr = `Found ${result.data.length} product(s):\n${productSummaries.join('\n')}`;
                  if (result.pagination?.hasMore) {
                    toolResultStr += `\n(More products available)`;
                    hasMoreProducts = true;
                  }

                  for (const p of result.data.slice(0, 5)) {
                    if (p.imageUrl) {
                      collectedProductImages.push(p.imageUrl);
                    }
                    collectedProductCards.push({
                      name: p.name,
                      description: p.description?.substring(0, 200),
                      price: p.price ? Number(p.price) : undefined,
                      imageUrl: p.imageUrl,
                    });
                  }
                } else {
                  toolResultStr = result.message || 'No products found matching your search.';
                }

                toolMessages.push({
                  role: "tool",
                  tool_call_id: toolCall.id,
                  content: toolResultStr,
                });
                console.log(`[WhatsApp Auto-Reply] Tool result: ${toolResultStr.substring(0, 200)}...`);
              } catch (err) {
                console.error(`[WhatsApp Auto-Reply] Tool execution error:`, err);
                toolMessages.push({
                  role: "tool",
                  tool_call_id: toolCall.id,
                  content: "Product search temporarily unavailable.",
                });
              }
            } else {
              toolMessages.push({
                role: "tool",
                tool_call_id: toolCall.id,
                content: `Tool ${fnName} is not available on WhatsApp.`,
              });
            }
          } catch (parseErr) {
            console.error(`[WhatsApp Auto-Reply] Tool call parse error:`, parseErr);
            toolMessages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: "Failed to process tool request.",
            });
          }
        }

        const cleanedUserMsg = userMessage.trim().replace(/[^\w\s]/g, '').trim();
        const isNumberSelection = /^\d{1,2}$/.test(cleanedUserMsg) || /^(option|number|item|choice)\s*\d{1,2}$/i.test(cleanedUserMsg);

        if (isNumberSelection) {
          toolMessages.push({
            role: "system",
            content: `WHATSAPP FORMAT — PRODUCT SELECTION RESPONSE: The user selected a specific product by number. Give a detailed, enthusiastic response about this product. Include the full description, key features, and price if available. End by offering next steps like "Would you like to book a free consultation?" or "Want to explore customization options?" Do NOT say "Reply with a number" — they already selected. Do NOT include image URLs or links. Use *bold* for the product name. Keep it conversational and helpful.`
          });
        } else {
          toolMessages.push({
            role: "system",
            content: `WHATSAPP FORMAT: Do NOT list individual product names or descriptions — those details will be sent separately as image captions. Instead, write a brief, friendly intro message (e.g., "Here are some wardrobe designs for you!") that naturally references what the user asked for. End with "Reply with a number to know more!" Keep it to 2-3 short sentences max. Do NOT include image URLs or links.`
          });
        }

        try {
          const followUpResponse = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: toolMessages,
            temperature: 0.3,
            max_tokens: isNumberSelection ? 800 : 500,
          });

          const text = followUpResponse.choices[0]?.message?.content;
          if (!text) return null;
          return { 
            text, 
            productImages: collectedProductImages.length > 0 ? collectedProductImages : undefined,
            productCards: collectedProductCards.length > 0 ? collectedProductCards : undefined,
            isProductSelection: isNumberSelection,
            hasMoreProducts,
          };
        } catch (followUpErr) {
          console.error(`[WhatsApp Auto-Reply] Follow-up completion after tool call failed:`, followUpErr);
          return { text: "I'm having trouble fetching product details right now. Please try again in a moment!" };
        }
      }

      const text = assistantMessage?.content;
      if (!text) return null;
      return { text };
      
    } catch (error) {
      console.error(`[WhatsApp Auto-Reply] OpenAI error:`, error);
      return null;
    }
  }

  private isDeflectionResponse(response: string): boolean {
    if (response.includes('[[FALLBACK]]')) {
      console.log('[WhatsApp Deflection] Detected via [[FALLBACK]] marker');
      return true;
    }
    
    const deflectionPatterns = [
      /I don't have .*?(information|details|data|pricing|info)/i,
      /I don't have .*?(available|on that|about that|for that)/i,
      /I (can't|cannot) .*?(answer|help|provide|find|assist)/i,
      /I don't know .*?(about|if|whether|the|that)/i,
      /I don't know\b/i,
      /I'm not sure .*?(about|if|whether|what)/i,
      /I'm not sure\b/i,
      /that's (outside|beyond) .*?(knowledge|expertise|information)/i,
      /I'm (not|unable to) (familiar with|aware of)/i,
      /I couldn't find .*?(information|details|data|anything)/i,
      /unfortunately.*?I (don't|can't|cannot)/i,
      /I apologize.*?(don't|can't|cannot|couldn't)/i,
      /no (specific |particular )?(information|details|data) (available|on|about)/i,
    ];
    
    const isPatternMatch = deflectionPatterns.some(pattern => pattern.test(response));
    if (isPatternMatch) {
      console.log('[WhatsApp Deflection] Detected via backup pattern matching');
    }
    return isPatternMatch;
  }

  private stripFallbackMarker(response: string): string {
    return response.replace(/\[\[FALLBACK\]\]\s*/g, '');
  }

  async sendSessionAwareMessage(
    settings: WhatsappSettings,
    recipientPhone: string,
    message: string,
    contextMessageId?: string
  ): Promise<{ success: boolean; messageId?: string; error?: string; usedTemplate?: boolean }> {
    const sessionOk = await isSessionActive(settings.businessAccountId, recipientPhone);

    if (!sessionOk) {
      console.log(`[WhatsApp Auto-Reply] 24h session expired for ${recipientPhone} — sending template`);
      if (!settings.sessionTemplateName) {
        console.error(`[WhatsApp Auto-Reply] No re-engagement template configured — cannot send`);
        return { success: false, error: "WhatsApp 24-hour session expired and no re-engagement template is configured", usedTemplate: false };
      }
      const tmplResult = await sendTemplateMessage(settings, recipientPhone, settings.sessionTemplateName);
      return { ...tmplResult, usedTemplate: true };
    }

    const result = await this.sendWhatsAppMessage(settings, recipientPhone, message, contextMessageId);

    if (!result.success && result.error && isSessionExpiredError(result.error)) {
      console.log(`[WhatsApp Auto-Reply] MSG91 error 131047 — session expired, retrying with template`);
      await markSessionExpired(settings.businessAccountId, recipientPhone);
      if (!settings.sessionTemplateName) {
        console.error(`[WhatsApp Auto-Reply] No re-engagement template configured — cannot fallback`);
        return { success: false, error: "Session expired (131047) and no re-engagement template configured" };
      }
      const tmplResult = await sendTemplateMessage(settings, recipientPhone, settings.sessionTemplateName);
      return { ...tmplResult, usedTemplate: true };
    }

    return result;
  }

  private async sendWhatsAppMessage(
    settings: WhatsappSettings,
    recipientPhone: string,
    message: string,
    contextMessageId?: string
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    try {
      if (!settings.msg91AuthKey) {
        return { success: false, error: "MSG91 auth key not configured" };
      }
      
      if (!settings.msg91IntegratedNumberId) {
        return { success: false, error: "MSG91 integrated number ID not configured" };
      }
      
      const cleanPhone = recipientPhone.replace(/\D/g, "");
      
      // MSG91 session message API uses query parameters (per official docs)
      // Endpoint: https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/
      const params: Record<string, string> = {
        integrated_number: settings.msg91IntegratedNumberId,
        recipient_number: cleanPhone,
        content_type: "text",
        text: message
      };
      
      // Add context message_id if provided (for replying to specific messages)
      // Try multiple parameter variations that MSG91 might accept
      if (contextMessageId) {
        // Clean the UUID - remove the "_hello" suffix that MSG91 adds
        const cleanUuid = contextMessageId.replace(/_hello$/, '');
        params.message_id = cleanUuid;
      }
      
      const urlParams = new URLSearchParams(params);
      const url = `https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/?${urlParams.toString()}`;
      
      console.log(`[WhatsApp Auto-Reply] Sending to MSG91:`, {
        integrated_number: settings.msg91IntegratedNumberId,
        recipient_number: cleanPhone,
        content_type: "text",
        message_id: params.message_id || 'none',
        text: message.substring(0, 50) + (message.length > 50 ? '...' : '')
      });
      
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "accept": "application/json",
          "authkey": settings.msg91AuthKey,
          "content-type": "application/json"
        }
      });
      
      const responseData = await response.json();
      console.log(`[WhatsApp Auto-Reply] MSG91 response:`, responseData);
      
      if (responseData.status === 'fail' || responseData.hasError) {
        return { 
          success: false, 
          error: responseData.errors || responseData.message || `MSG91 error: ${response.status}` 
        };
      }
      
      return { 
        success: true, 
        messageId: responseData.data?.id || responseData.message_id 
      };
      
    } catch (error) {
      console.error(`[WhatsApp Auto-Reply] Send error:`, error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : "Failed to send message" 
      };
    }
  }

  private async sendWhatsAppImage(
    settings: WhatsappSettings,
    recipientPhone: string,
    imageUrl: string,
    caption?: string
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    try {
      if (!settings.msg91AuthKey || !settings.msg91IntegratedNumberId) {
        return { success: false, error: "MSG91 credentials not configured" };
      }

      const cleanPhone = recipientPhone.replace(/\D/g, "");

      const payload: any = {
        integrated_number: settings.msg91IntegratedNumberId,
        recipient_number: cleanPhone,
        content_type: "image",
        attachment_url: imageUrl,
      };
      if (caption) {
        payload.caption = caption;
      }

      const url = "https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/";

      console.log(`[WhatsApp Auto-Reply] Sending image to ${cleanPhone}:`, {
        imageUrl: imageUrl.substring(0, 80) + (imageUrl.length > 80 ? "..." : ""),
      });

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "accept": "application/json",
          "authkey": settings.msg91AuthKey,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const responseData = await response.json();
      console.log(`[WhatsApp Auto-Reply] MSG91 image response:`, responseData);

      if (responseData.status === 'fail' || responseData.hasError) {
        return {
          success: false,
          error: responseData.errors || responseData.message || `MSG91 error: ${response.status}`,
        };
      }

      return {
        success: true,
        messageId: responseData.data?.id || responseData.message_id,
      };
    } catch (error) {
      console.error(`[WhatsApp Auto-Reply] Send image error:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to send image",
      };
    }
  }

  private async storeOutgoingMessage(
    businessAccountId: string,
    recipientPhone: string,
    message: string,
    flowSessionId?: string
  ): Promise<void> {
    try {
      const outgoingMessage: InsertWhatsappLead = {
        businessAccountId,
        senderPhone: recipientPhone,
        rawMessage: message,
        status: "message_only",
        direction: "outgoing",
        flowSessionId: flowSessionId || null,
        receivedAt: new Date()
      };
      
      await db.insert(whatsappLeads).values(outgoingMessage);
      console.log(`[WhatsApp Auto-Reply] Stored outgoing message for ${recipientPhone}${flowSessionId ? ` (session: ${flowSessionId})` : ''}`);
      
    } catch (error) {
      console.error(`[WhatsApp Auto-Reply] Failed to store outgoing message:`, error);
    }
  }

  async sendInteractiveButtons(
    settings: WhatsappSettings,
    recipientPhone: string,
    bodyText: string,
    buttons: { id: string; title: string }[],
    flowSessionId?: string
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    try {
      if (!settings.msg91AuthKey || !settings.msg91IntegratedNumberId) {
        return { success: false, error: "MSG91 credentials not configured" };
      }

      const cleanPhone = recipientPhone.replace(/\D/g, "");
      
      const payload = {
        recipient_number: cleanPhone,
        integrated_number: settings.msg91IntegratedNumberId,
        content_type: "interactive",
        interactive: {
          type: "button",
          body: { text: bodyText },
          action: {
            buttons: buttons.slice(0, 3).map(btn => ({
              type: "reply",
              reply: {
                id: btn.id,
                title: btn.title.substring(0, 20)
              }
            }))
          }
        }
      };

      const url = "https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/";

      console.log(`[WhatsApp Flow] Sending interactive buttons to ${cleanPhone}`);

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "accept": "application/json",
          "authkey": settings.msg91AuthKey,
          "content-type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      const responseData = await response.json();
      console.log(`[WhatsApp Flow] MSG91 response:`, responseData);

      if (responseData.status === 'fail' || responseData.hasError) {
        return { 
          success: false, 
          error: responseData.errors || responseData.message || `MSG91 error: ${response.status}` 
        };
      }

      await this.storeOutgoingMessage(
        settings.businessAccountId,
        recipientPhone,
        bodyText,
        flowSessionId
      );

      return { 
        success: true, 
        messageId: responseData.data?.id || responseData.message_id 
      };

    } catch (error) {
      console.error(`[WhatsApp Flow] Send buttons error:`, error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : "Failed to send buttons" 
      };
    }
  }

  async sendInteractiveList(
    settings: WhatsappSettings,
    recipientPhone: string,
    bodyText: string,
    buttonText: string,
    sections: { title: string; rows: { id: string; title: string; description?: string }[] }[],
    flowSessionId?: string
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    try {
      if (!settings.msg91AuthKey || !settings.msg91IntegratedNumberId) {
        return { success: false, error: "MSG91 credentials not configured" };
      }

      const cleanPhone = recipientPhone.replace(/\D/g, "");
      
      const payload = {
        recipient_number: cleanPhone,
        integrated_number: settings.msg91IntegratedNumberId,
        content_type: "interactive",
        interactive: {
          type: "list",
          body: { text: bodyText },
          action: {
            button: buttonText.substring(0, 20),
            sections: sections.map(section => ({
              title: section.title.substring(0, 24),
              rows: section.rows.slice(0, 10).map(row => ({
                id: row.id,
                title: row.title.substring(0, 24),
                description: row.description?.substring(0, 72)
              }))
            }))
          }
        }
      };

      const url = "https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/";

      console.log(`[WhatsApp Flow] Sending interactive list to ${cleanPhone}`);

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "accept": "application/json",
          "authkey": settings.msg91AuthKey,
          "content-type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      const responseData = await response.json();
      console.log(`[WhatsApp Flow] MSG91 response:`, responseData);

      if (responseData.status === 'fail' || responseData.hasError) {
        return { 
          success: false, 
          error: responseData.errors || responseData.message || `MSG91 error: ${response.status}` 
        };
      }

      await this.storeOutgoingMessage(
        settings.businessAccountId,
        recipientPhone,
        bodyText,
        flowSessionId
      );

      return { 
        success: true, 
        messageId: responseData.data?.id || responseData.message_id 
      };

    } catch (error) {
      console.error(`[WhatsApp Flow] Send list error:`, error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : "Failed to send list" 
      };
    }
  }

  async sendFlowResponse(
    settings: WhatsappSettings,
    recipientPhone: string,
    response: {
      type: "text" | "buttons" | "list";
      text: string;
      buttons?: { id: string; title: string }[];
      sections?: { title: string; rows: { id: string; title: string; description?: string }[] }[];
      buttonText?: string;
    },
    flowSessionId?: string
  ): Promise<{ success: boolean; error?: string }> {
    switch (response.type) {
      case "buttons":
        if (response.buttons && response.buttons.length > 0) {
          return await this.sendInteractiveButtons(
            settings,
            recipientPhone,
            response.text,
            response.buttons,
            flowSessionId
          );
        }
        break;

      case "list":
        if (response.sections && response.sections.length > 0) {
          return await this.sendInteractiveList(
            settings,
            recipientPhone,
            response.text,
            response.buttonText || "Select",
            response.sections,
            flowSessionId
          );
        }
        break;

      case "text":
      default:
        const textResult = await this.sendWhatsAppMessage(
          settings,
          recipientPhone,
          response.text
        );
        if (textResult.success) {
          await this.storeOutgoingMessage(
            settings.businessAccountId,
            recipientPhone,
            response.text,
            flowSessionId
          );
        }
        return textResult;
    }

    const fallbackResult = await this.sendWhatsAppMessage(settings, recipientPhone, response.text);
    if (fallbackResult.success) {
      await this.storeOutgoingMessage(
        settings.businessAccountId,
        recipientPhone,
        response.text,
        flowSessionId
      );
    }
    return fallbackResult;
  }
}

export const whatsappAutoReplyService = new WhatsappAutoReplyService();
