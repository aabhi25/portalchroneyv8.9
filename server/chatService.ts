import OpenAI from 'openai';
import { llamaService } from './llamaService';
import { aiTools, selectRelevantTools } from './aiTools';
import { ToolExecutionService } from './services/toolExecutionService';
import { conversationMemory } from './conversationMemory';
import { storage } from './storage';
import { businessContextCache, BusinessContextCache } from './services/businessContextCache';
import { autoEscalationService } from './services/autoEscalationService';
import { feedbackMonitoringService } from './services/feedbackMonitoringService';
import { journeyService } from './services/journeyService';
import { journeyOrchestrator } from './services/journeyOrchestrator';
import { vectorSearchService } from './services/vectorSearchService';
import { checkDiscountEligibility } from './services/nudgeOrchestrationService';
import { isGibberishAI } from './services/spamDetectionService';
import { categorizeAndSaveConversation } from './services/conversationCategorizationService';
import { summarizeAndSaveConversation } from './services/conversationSummarizationService';
import { buildLeadTrainingPrompt, buildPhoneValidationOverride } from './services/leadTrainingPrompt';
import { resolveProfile } from './services/customerProfileService';
import { composeCrossPlatformContext, triggerSnapshotUpdate } from './services/crossPlatformMemoryService';
import { validatePhoneNumber } from '../shared/validation/phone';

export interface ChatContext {
  userId: string;
  businessAccountId: string;
  personality?: string;
  responseLength?: string;
  companyDescription?: string;
  openaiApiKey?: string | null;
  currency?: string;
  currencySymbol?: string;
  customInstructions?: string;
  customerName?: string;
  journeyConversationalGuidelines?: string;
  preferredLanguage?: string;
  visitorSessionId?: string;
  visitorCity?: string;
  visitorToken?: string; // Unique token for conversation history filtering
  isInternalTest?: boolean; // True when business user is testing their own chatbot from dashboard
  skipLeadTraining?: boolean; // True for guidance chatbot - skip lead collection
  starterQAContext?: string; // Pre-formatted Q&A context from guidance conversation starters
  supportsCalendarUI?: boolean; // True when client can render visual calendar for appointment slots
  pageUrl?: string; // Parent page URL where the widget is embedded (for UTM tracking)
  systemMode?: string; // 'full' | 'essential'
  k12EducationEnabled?: boolean;
  jobPortalEnabled?: boolean;
  resumeText?: string;
  resumeUrl?: string;
}

// Track active conversation IDs for each user session
const activeConversations = new Map<string, string>();

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export class ChatService {
  // Track last escalation check per conversation to prevent repeated expensive checks
  private lastEscalationCheck = new Map<string, number>();
  private readonly ESCALATION_CHECK_DEBOUNCE_MS = 5000; // Only check every 5 seconds
  
  // Cache for fallback instructions per business account (used when AI can't answer)
  private fallbackInstructionsCache = new Map<string, string[]>();
  
  // Helper function to extract the last substantive user question
  // Handles mixed messages like "my phone is 9898989898. what are your services?"
  private extractLastSubstantiveQuestion(history: ChatMessage[], currentUserMessage?: string): string {
    // Include current user message in the search
    const allMessages = currentUserMessage 
      ? [...history, { role: 'user' as const, content: currentUserMessage }]
      : history;
    
    const userMessages = allMessages.filter(msg => msg.role === 'user');
    
    // Go backwards through user messages to find the last real question
    for (let i = userMessages.length - 1; i >= 0; i--) {
      const msg = userMessages[i].content.trim();
      
      // CRITICAL: Handle mixed messages (contact info + question)
      // Example: "my phone is 9898989898. what are your services?"
      // Strategy: Remove contact info portions, check if remaining content is substantive
      
      // Remove phone numbers from message
      let cleanedMsg = msg.replace(/\b\+?[\d\s\-()]{7,15}\b/g, '').trim();
      
      // Remove emails from message
      cleanedMsg = cleanedMsg.replace(/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/g, '').trim();
      
      // Remove common contact info filler phrases
      cleanedMsg = cleanedMsg.replace(/\b(my|here('s| is)|the|your)?\s*(phone|mobile|number|whatsapp|contact|email|e-mail|mail|name)(\s+(is|:))?\s*/gi, '').trim();
      cleanedMsg = cleanedMsg.replace(/\b(i'm|i am|called|my name is)\s*/gi, '').trim();
      
      // Remove courtesy/acknowledgment phrases that aren't real questions
      // Remove punctuation for easier matching
      const courtesyFree = cleanedMsg.replace(/[.,!?]/g, '').trim().toLowerCase();
      const isCourtesy = /^(thanks?|thank you|okay|ok|sure|got it|great|nice|good|yes|yep|yeah|yup|fine|perfect|alright|all? ?right)$/i.test(courtesyFree);
      
      // CRITICAL: Check for interrogative cues that indicate a real question
      // If message has question marks or question words, it's substantive even if short
      const hasQuestionMark = /\?/.test(cleanedMsg);
      const hasQuestionWord = /\b(what|why|how|when|where|which|who|whose|whom|can|could|would|should|will|do|does|did|is|are|was|were|tell|show|explain|describe)\b/i.test(cleanedMsg);
      const isInterrogative = hasQuestionMark || hasQuestionWord;
      
      // Check for action/intent words that indicate a real request (not a name)
      const hasActionIntent = /\b(need|want|help|please|price|pricing|cost|tell|show|give|send|get|find|explain|describe|info|information|details|about|regarding)\b/i.test(cleanedMsg);
      
      // STRICT name detection: Only treat as name if it's TRULY just a name
      // Real names: "John Smith", "Mary Jane" (2-3 capitalized words, no verbs/action words)
      // Single words like "Need" or "Pricing" are NOT names
      const words = cleanedMsg.replace(/[.,!?]/g, '').trim().split(/\s+/);
      const looksLikeName = words.length >= 2 &&  // MUST have at least 2 words (first + last name)
                            words.length <= 3 && 
                            words.every(w => /^[A-Z][a-z]+$/.test(w)) && // Each word: Capital + lowercase
                            !isInterrogative && 
                            !hasActionIntent; // No action words
      
      // If cleaned message is empty or just courtesy, skip it
      // BUT: Allow short questions (< 5 chars) if they have interrogative cues like "fees?" or "MBA?"
      if (!cleanedMsg || isCourtesy) {
        console.log(`[Question Extraction] Skipping empty/courtesy: "${msg}"`);
        continue;
      }
      
      // Skip very short messages UNLESS they have a question mark or question word
      if (cleanedMsg.length < 5 && !isInterrogative) {
        console.log(`[Question Extraction] Skipping short non-question: "${msg}"`);
        continue;
      }
      
      // Only skip if it's STRICTLY a name (not capitalized statements)
      if (looksLikeName) {
        console.log(`[Question Extraction] Skipping name-only message: "${msg}"`);
        continue;
      }
      
      // If we have substantial content after removing contact info, use the ORIGINAL message
      // This preserves context while ensuring there's a real question
      // Also allow short interrogative messages like "fees?" or "MBA?"
      if (cleanedMsg.length >= 5 || isInterrogative) {
        console.log(`[Question Extraction] Found substantive question: "${msg}" (cleaned: "${cleanedMsg}", interrogative: ${isInterrogative})`);
        return msg; // Return original message, not cleaned version
      }
    }
    
    console.log('[Question Extraction] No substantive question found in history');
    return ''; // No substantive question found
  }
  
  // Check if required lead fields were just completed (comparing before/after state)
  private async checkLeadCompletionStatus(
    conversationId: string,
    businessAccountId: string,
    widgetSettings: any,
    leadBeforeCapture: any // Lead state BEFORE autoDetectAndCaptureLead ran
  ): Promise<{ justCompleted: boolean }> {
    try {
      // Get lead training config
      const leadTrainingConfig = widgetSettings?.leadTrainingConfig as any;
      if (!leadTrainingConfig || !leadTrainingConfig.fields || !Array.isArray(leadTrainingConfig.fields)) {
        return { justCompleted: false };
      }
      
      // Get required fields with "start" timing
      const requiredStartFields = leadTrainingConfig.fields
        .filter((f: any) => f.enabled && f.required && f.captureStrategy === 'start');
      
      if (requiredStartFields.length === 0) {
        return { justCompleted: false };
      }
      
      // Helper to check if all required fields are present in a lead
      const hasAllRequiredFields = (lead: any) => {
        if (!lead) return false;
        
        return requiredStartFields.every((field: any) => {
          const fieldId = field.id.toLowerCase();
          if (fieldId === 'mobile' || fieldId === 'phone' || fieldId === 'whatsapp') {
            return !!lead.phone;
          } else if (fieldId === 'email') {
            return !!lead.email;
          } else if (fieldId === 'name') {
            return !!lead.name;
          }
          return false;
        });
      };
      
      // Check state before and after
      const wasComplete = hasAllRequiredFields(leadBeforeCapture);
      
      // Get current lead state (after auto-detection)
      const currentLead = await storage.getLeadByConversation(conversationId, businessAccountId);
      const isNowComplete = hasAllRequiredFields(currentLead);
      
      // JUST completed = was incomplete before, but complete now
      const justCompleted = !wasComplete && isNowComplete;
      
      if (justCompleted) {
        console.log('[Lead Completion] Lead state transition detected:');
        console.log('[Lead Completion] Before:', leadBeforeCapture);
        console.log('[Lead Completion] After:', currentLead);
      }
      
      return { justCompleted };
    } catch (error) {
      console.error('[Lead Completion Check] Error:', error);
      return { justCompleted: false };
    }
  }
  
  // Get or create a conversation for the current session
  private async getOrCreateConversation(context: ChatContext): Promise<string> {
    const sessionKey = `${context.userId}_${context.businessAccountId}`;
    
    // Check if we have an active conversation for this session
    let conversationId = activeConversations.get(sessionKey);
    
    if (!conversationId) {
      // Try to reuse a recent conversation for this visitor (same-session dedup)
      if (context.visitorToken) {
        const reusable = await storage.findReusableConversation(context.businessAccountId, context.visitorToken);
        if (reusable) {
          conversationId = reusable.id;
          activeConversations.set(sessionKey, conversationId);
          console.log('[Chat] Reusing existing conversation:', conversationId, 'for visitorToken:', context.visitorToken);
          return conversationId;
        }
      }

      // Use customer name if provided, otherwise 'Anonymous'
      const conversationTitle = context.customerName || 'Anonymous';
      
      // Create a new conversation in the database
      const conversation = await storage.createConversation({
        businessAccountId: context.businessAccountId,
        title: conversationTitle,
        visitorCity: context.visitorCity || null,
        visitorToken: context.visitorToken || null,
        isInternalTest: context.isInternalTest ? 'true' : 'false'
      });
      conversationId = conversation.id;
      activeConversations.set(sessionKey, conversationId);
      
      console.log('[Chat] Created new conversation:', conversationId, 'for:', conversationTitle, 'city:', context.visitorCity || 'unknown', 'visitorToken:', context.visitorToken ? 'present' : 'none');
    }
    
    return conversationId;
  }

  // Store message in database
  // Skip for temp conversations (spam detection)
  private async storeMessageInDB(
    conversationId: string, 
    role: 'user' | 'assistant', 
    content: string,
    metadata?: { productIds?: string[] }
  ): Promise<void> {
    // Skip DB storage for temporary spam conversations
    if (conversationId.startsWith('temp_')) {
      return;
    }
    
    try {
      await storage.createMessage({
        conversationId,
        role,
        content,
        metadata: metadata ? JSON.stringify(metadata) : undefined,
        interactionSource: 'chat'
      });
      
      // Update conversation timestamp
      await storage.updateConversationTimestamp(conversationId);
    } catch (error) {
      console.error('[Chat] Error storing message in DB:', error);
    }
  }

  // Generate a short conversation title from the first user message
  private async generateConversationTitle(userMessage: string, apiKey: string): Promise<string> {
    try {
      const openai = new OpenAI({ apiKey });
      
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'Generate a very short 2-4 word title that summarizes the user\'s question or topic. No punctuation. Be concise and descriptive. Examples: "Product Pricing", "Delivery Options", "Account Setup", "Order Status"'
          },
          {
            role: 'user',
            content: userMessage
          }
        ],
        max_tokens: 20,
        temperature: 0.3
      });
      
      const title = response.choices[0]?.message?.content?.trim() || 'New Chat';
      console.log('[Chat] Generated conversation title:', title);
      return title;
    } catch (error) {
      console.error('[Chat] Error generating title:', error);
      return 'New Chat';
    }
  }

  // Simple AI response for spam/gibberish messages - no DB, no tools, just natural response
  private async getSimpleAIResponse(userMessage: string, context: ChatContext): Promise<string> {
    try {
      const openai = new OpenAI({ apiKey: context.openaiApiKey! });
      
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are a friendly customer support assistant for ${context.companyDescription || 'a business'}. The user's message appears unclear or may contain a typo. Politely ask them to clarify what they need help with. Keep your response brief and helpful.`
          },
          {
            role: 'user',
            content: userMessage
          }
        ],
        max_tokens: 150,
        temperature: 0.7
      });
      
      return response.choices[0]?.message?.content?.trim() || "I'm sorry, I didn't quite understand that. Could you please rephrase your question?";
    } catch (error) {
      console.error('[Chat] Error in simple AI response:', error);
      return "I'm sorry, I didn't quite understand that. Could you please rephrase your question?";
    }
  }

  // Update conversation title if it's still the default "Anonymous" or "New Chat"
  private async maybeUpdateConversationTitle(
    conversationId: string, 
    businessAccountId: string, 
    userMessage: string, 
    apiKey: string
  ): Promise<void> {
    try {
      // Get current conversation to check title
      const conversation = await storage.getConversation(conversationId, businessAccountId);
      if (!conversation) return;
      
      // Only update if title is still "Anonymous" or "New Chat"
      if (conversation.title === 'Anonymous' || conversation.title === 'New Chat') {
        const newTitle = await this.generateConversationTitle(userMessage, apiKey);
        await storage.updateConversationTitle(conversationId, businessAccountId, newTitle);
        console.log('[Chat] Updated conversation title from:', conversation.title, 'to:', newTitle);
      }
    } catch (error) {
      console.error('[Chat] Error updating conversation title:', error);
    }
  }

  // Helper method to detect if AI response is a deflection/generic response
  // PRIMARY: Check for [[FALLBACK]] marker (AI-driven detection)
  // BACKUP: Pattern matching for edge cases where AI didn't use marker
  private isDeflectionResponse(response: string): boolean {
    // PRIMARY: AI-driven detection via [[FALLBACK]] marker
    if (response.includes('[[FALLBACK]]')) {
      console.log('[Deflection] Detected via [[FALLBACK]] marker');
      return true;
    }
    
    // BACKUP: Pattern-based detection for edge cases
    // BROADER PATTERNS: Use .*? to allow words between key phrases (e.g., "specific fee information")
    const deflectionPatterns = [
      // "I don't have [anything] information/details/data" - catches all variations
      /I don't have .*?(information|details|data|pricing|info)/i,
      /I don't have .*?(available|on that|about that|for that)/i,
      // "I cannot/can't [anything]" patterns
      /I (can't|cannot) .*?(answer|help|provide|find|assist)/i,
      // "I don't know" patterns
      /I don't know .*?(about|if|whether|the|that)/i,
      /I don't know\b/i,
      // Uncertainty patterns
      /I'm not sure .*?(about|if|whether|what)/i,
      /I'm not sure\b/i,
      // Outside knowledge patterns
      /that's (outside|beyond) .*?(knowledge|expertise|information)/i,
      /I'm (not|unable to) (familiar with|aware of)/i,
      // Couldn't find patterns
      /I couldn't find .*?(information|details|data|anything)/i,
      // Apologetic deflections
      /unfortunately.*?I (don't|can't|cannot)/i,
      /I apologize.*?(don't|can't|cannot|couldn't)/i,
      // Simple "no information" patterns
      /no (specific |particular )?(information|details|data) (available|on|about)/i,
    ];
    
    const isPatternMatch = deflectionPatterns.some(pattern => pattern.test(response));
    if (isPatternMatch) {
      console.log('[Deflection] Detected via backup pattern matching');
    }
    return isPatternMatch;
  }
  
  // Strip [[FALLBACK]] marker from response content
  // NOTE: Do not trim() here as it removes spaces from streaming chunks
  private stripFallbackMarker(response: string): string {
    return response.replace(/\[\[FALLBACK\]\]\s*/g, '');
  }
  
  // Process conditional placeholders in fallback templates based on lead data
  // Supports: {{if_missing_phone}}...{{/if_missing_phone}}, {{if_has_phone}}...{{/if_has_phone}}
  // Also: {{if_missing_email}}, {{if_has_email}}, {{if_missing_name}}, {{if_has_name}}
  private processFallbackPlaceholders(template: string, existingLead: any): string {
    let processed = template;
    
    // Define field mappings: placeholder field name -> lead property
    const fieldMappings: Record<string, string> = {
      'phone': 'phone',
      'mobile': 'phone',
      'email': 'email',
      'name': 'name',
      'whatsapp': 'phone'
    };
    
    // Process each field type
    for (const [placeholderField, leadProperty] of Object.entries(fieldMappings)) {
      const hasValue = existingLead?.[leadProperty] && existingLead[leadProperty].trim() !== '';
      
      // Pattern for {{if_missing_X}}...{{/if_missing_X}}
      const missingPattern = new RegExp(
        `\\{\\{if_missing_${placeholderField}\\}\\}([\\s\\S]*?)\\{\\{\\/if_missing_${placeholderField}\\}\\}`,
        'gi'
      );
      
      // Pattern for {{if_has_X}}...{{/if_has_X}}
      const hasPattern = new RegExp(
        `\\{\\{if_has_${placeholderField}\\}\\}([\\s\\S]*?)\\{\\{\\/if_has_${placeholderField}\\}\\}`,
        'gi'
      );
      
      if (hasValue) {
        // Lead has this field: remove if_missing blocks, keep if_has content
        processed = processed.replace(missingPattern, '');
        processed = processed.replace(hasPattern, '$1');
      } else {
        // Lead is missing this field: keep if_missing content, remove if_has blocks
        processed = processed.replace(missingPattern, '$1');
        processed = processed.replace(hasPattern, '');
      }
    }
    
    // Clean up any double spaces or extra newlines from removed blocks
    processed = processed.replace(/\n\s*\n\s*\n/g, '\n\n').trim();
    
    console.log(`[Fallback Placeholders] Processed template. Lead has phone: ${!!existingLead?.phone}, email: ${!!existingLead?.email}, name: ${!!existingLead?.name}`);
    
    return processed;
  }
  
  // Enhanced fallback message with business context and sales-oriented approach
  // Gathers business info and generates a helpful response while preserving lead capture intent
  // Now accepts existingLead to ensure AI doesn't ask for contact info that already exists
  private async rephraseFallbackMessage(
    template: string, 
    userQuestion: string,
    businessAccountId: string,
    apiKey?: string,
    existingLead?: any
  ): Promise<string> {
    // Determine what contact info the lead already has (outside try so available in catch)
    const hasPhone = !!(existingLead?.phone && existingLead.phone.trim());
    const hasEmail = !!(existingLead?.email && existingLead.email.trim());
    const hasName = !!(existingLead?.name && existingLead.name.trim());
    
    // SAFETY NET: Strip phone/mobile/WhatsApp requests from template if phone already captured
    // This prevents asking for phone again even if the fallback template doesn't use {{if_has_phone}} guards
    // Hoisted outside try block so it's available in catch for error fallback
    let processedTemplate = template;
    if (hasPhone) {
      // Remove sentences asking for phone/mobile/WhatsApp
      processedTemplate = processedTemplate
        .replace(/[^.]*\b(share|provide|give|send|tell|have)\b[^.]*\b(phone|mobile|whatsapp|cell)\b[^.]*[.!?]?\s*/gi, '')
        .replace(/[^.]*\b(phone|mobile|whatsapp|cell)\b[^.]*\b(number)\b[^.]*[.!?]?\s*/gi, '')
        .trim();
      if (processedTemplate !== template) {
        console.log('[Fallback Rephrase] Stripped phone request from template since phone already captured');
      }
    }
    if (hasEmail) {
      // Remove sentences asking for email
      processedTemplate = processedTemplate
        .replace(/[^.]*\b(share|provide|give|send|tell|have)\b[^.]*\b(email)\b[^.]*[.!?]?\s*/gi, '')
        .trim();
      if (processedTemplate !== template) {
        console.log('[Fallback Rephrase] Stripped email request from template since email already captured');
      }
    }
    
    try {
      // Build restriction message for AI
      let contactRestrictions = '';
      const alreadyHas: string[] = [];
      if (hasPhone) alreadyHas.push('phone/mobile number');
      if (hasEmail) alreadyHas.push('email');
      if (hasName) alreadyHas.push('name');
      
      if (alreadyHas.length > 0) {
        contactRestrictions = `\n\nCRITICAL: The user has ALREADY provided their ${alreadyHas.join(', ')}. Do NOT ask for ${alreadyHas.join(' or ')} again under any circumstances.`;
      }
      
      // Gather business context from multiple sources
      const [businessAccount, allFaqs] = await Promise.all([
        storage.getBusinessAccount(businessAccountId),
        storage.getAllFaqs(businessAccountId)
      ]);
      
      // Get business description and name
      const businessDescription = businessAccount?.description?.trim() || '';
      const businessName = businessAccount?.name?.trim() || '';
      
      // Search FAQs for "about us" type content (general business info)
      // Safely handle null/empty FAQ fields
      const aboutKeywords = ['about', 'who we are', 'company', 'business', 'services', 'what we do', 'offer', 'specialize'];
      const aboutFaqs = allFaqs.filter(faq => {
        const questionLower = (faq.question || '').toLowerCase();
        const answerLower = (faq.answer || '').toLowerCase();
        if (!questionLower && !answerLower) return false;
        return aboutKeywords.some(keyword => 
          questionLower.includes(keyword) || answerLower.includes(keyword)
        );
      }).slice(0, 2); // Take top 2 relevant FAQs
      
      // Build business context string - skip empty sections
      let businessContext = '';
      if (businessDescription) {
        businessContext += `Business Overview: ${businessDescription}\n`;
      }
      if (aboutFaqs.length > 0) {
        businessContext += 'General Business Info:\n';
        aboutFaqs.forEach(faq => {
          if (faq.question && faq.answer) {
            const truncatedAnswer = faq.answer.length > 200 ? faq.answer.substring(0, 200) + '...' : faq.answer;
            businessContext += `- ${faq.question}: ${truncatedAnswer}\n`;
          }
        });
      }
      
      // If we have business context, generate enhanced response
      if (businessContext.trim()) {
        console.log('[Fallback Rephrase] Found business context, generating sales-oriented response. Lead has phone:', hasPhone, 'email:', hasEmail);
        
        const response = await llamaService.generateSimpleResponse(
          `You are a helpful sales assistant for ${businessName || 'this business'}. You want to be helpful and keep the user engaged.

USER'S QUESTION: "a question outside the scope of this business"

BUSINESS CONTEXT (use this to sound knowledgeable):
${businessContext}

FALLBACK MESSAGE TO USE AS BASE:
${processedTemplate}${contactRestrictions}

🚨 CRITICAL - BANNED PHRASES (NEVER USE):
❌ "I don't have information about..."
❌ "I don't have specific information..."
❌ "I don't know..."
❌ "I'm not sure about..."
❌ "I cannot answer that..."

Generate a response that:
1. Stays POSITIVE - acknowledge their interest without admitting any limitations
2. Redirects gracefully - offer to connect them with the team who can help
3. Shares 1-2 relevant highlights about YOUR business (be helpful, not salesy)
4. Follow the fallback message intent EXACTLY - only ask for contact info if it appears in the fallback message above

EXAMPLE - WRONG: "I don't have specific information about MBBS, but..."
EXAMPLE - RIGHT: "That's an interesting area! I'd be happy to connect you with our team who can guide you on this."

Keep it natural, conversational, and under 3 sentences. Sound confident and solution-oriented.`,
          apiKey
        );
        
        if (response && response.trim()) {
          const trimmed = response.trim();
          if (!/[.!?]['"]?$/.test(trimmed)) {
            console.warn('[Fallback Rephrase] Truncated response detected (no sentence end), using template directly');
            return processedTemplate;
          }
          console.log('[Fallback Rephrase] Successfully generated enhanced message with business context');
          return trimmed;
        }
      }
      
      // No business context available - fall back to simple rephrasing
      console.log('[Fallback Rephrase] No business context, using simple rephrasing. Lead has phone:', hasPhone, 'email:', hasEmail);
      const response = await llamaService.generateSimpleResponse(
        `You are a helpful assistant. Rephrase the following message in a natural, conversational way while keeping the EXACT same meaning and intent.

The user asked: "a question outside the scope of this business"

Message to rephrase:
${processedTemplate}${contactRestrictions}

🚨 BANNED PHRASES (NEVER USE):
❌ "I don't have information..."
❌ "I don't know..."
❌ "I'm not sure..."

Rephrased message (keep it concise, same length, same intent, stay POSITIVE - never say "I don't have" or "I don't know"):`,
        apiKey
      );
      
      if (response && response.trim()) {
        const trimmed = response.trim();
        if (!/[.!?]['"]?$/.test(trimmed)) {
          console.warn('[Fallback Rephrase] Truncated response detected (no sentence end), using template directly');
          return processedTemplate;
        }
        console.log('[Fallback Rephrase] Successfully varied message');
        return trimmed;
      }
      return processedTemplate;
    } catch (error) {
      console.error('[Fallback Rephrase] Error, using sanitized template:', error);
      return processedTemplate;
    }
  }
  
  // AI-driven post-capture response generation
  // Instead of complex branching logic, let AI naturally handle the conversation after lead capture
  private async generatePostCaptureResponse(
    originalQuestion: string | null,
    capturedData: { phone?: string; email?: string; name?: string },
    previousAIResponse: string | null,
    businessAccountId: string,
    apiKey?: string
  ): Promise<string> {
    try {
      // Check if previous response was asking for contact info
      // If YES: The AI already addressed the question (or said team will help), so just confirm handoff
      // NO AI CALL NEEDED - hardcoded response is more reliable and faster
      const previousAskedForContact = previousAIResponse && this.isContactRequestMessage(previousAIResponse);
      
      if (previousAskedForContact) {
        // SIMPLE HANDOFF CONFIRMATION - no AI needed, no risk of re-addressing the question
        console.log('[Post-Capture] Previous asked for contact - using simple confirmation (no AI call)');
        return "Thank you for sharing your details! Our team will reach out to you shortly with the information you need. Feel free to ask if you have any other questions!";
      }
      
      // For other cases (e.g., start-timing where AI asked for contact before answering),
      // use AI to generate a contextual response
      const capturedFields: string[] = [];
      if (capturedData.phone) capturedFields.push(`phone: ${capturedData.phone}`);
      if (capturedData.email) capturedFields.push(`email: ${capturedData.email}`);
      if (capturedData.name) capturedFields.push(`name: ${capturedData.name}`);
      
      const prompt = `You just captured the user's contact information.

CAPTURED: ${capturedFields.join(', ') || 'contact info'}

Generate a brief, warm response (1-2 sentences) that:
1. Thanks them for sharing their contact
2. Confirms our team will reach out with the details they need
3. Invites them to ask other questions

Do NOT try to answer any previous questions - just confirm the handoff.

Response:`;

      const response = await llamaService.generateSimpleResponse(prompt, apiKey);
      
      if (response && response.trim()) {
        console.log('[Post-Capture AI] Generated natural response');
        return response.trim();
      }
      
      // Fallback if AI fails
      return "Thank you for sharing your details! Our team will reach out to you shortly with the information you need.";
    } catch (error) {
      console.error('[Post-Capture AI] Error generating response:', error);
      return "Thank you for sharing your details! Our team will reach out to you shortly with the information you need.";
    }
  }
  
  // Check if a message is asking for contact information (typical fallback response)
  // Used to avoid re-processing questions that already hit fallback
  private isContactRequestMessage(message: string): boolean {
    if (!message) return false;
    const lowerMessage = message.toLowerCase();
    
    // Common patterns in fallback messages that ask for contact info
    const contactRequestPatterns = [
      /share.*(your|contact|phone|mobile|number|email|whatsapp)/i,
      /provide.*(your|contact|phone|mobile|number|email|whatsapp)/i,
      /give.*(your|contact|phone|mobile|number|email|whatsapp)/i,
      /(phone|mobile|email|whatsapp|contact).*(number|address|info|details)/i,
      /reach out to you/i,
      /get back to you/i,
      /contact you/i,
      /our team can (call|contact|reach|help)/i,
      /so we can (call|contact|reach|help)/i,
    ];
    
    return contactRequestPatterns.some(pattern => pattern.test(lowerMessage));
  }
  
  // Check if a message is a "handoff confirmation" - AI confirmed team will reach out
  // This is the POST-capture state where the question has been "resolved" (handed to human team)
  private isHandoffConfirmationMessage(message: string): boolean {
    if (!message) return false;
    
    // Patterns that indicate the conversation has been "handed off" to human team
    const handoffPatterns = [
      /team will (reach out|contact|get back|call|help)/i,
      /(will|shall) (reach out|contact|get back|call)/i,
      /someone (will|from our team)/i,
      /we('ll| will) (be in touch|contact you|reach out|get back)/i,
      /expect.*(call|contact|hear from)/i,
      /thank.*(for sharing|for providing|for your).*(contact|number|phone|details)/i,
    ];
    
    return handoffPatterns.some(pattern => pattern.test(message));
  }
  
  // Check if a user message is a simple acknowledgement (yes, ok, thanks, etc.)
  private isSimpleAcknowledgement(message: string): boolean {
    if (!message) return false;
    const cleaned = message.replace(/[.,!?]/g, '').trim().toLowerCase();
    
    // Simple acknowledgement patterns
    const ackPatterns = /^(yes|yeah|yep|yup|ok|okay|sure|fine|alright|all ?right|great|good|nice|perfect|thanks?|thank you|got it|understood|cool|awesome)$/i;
    
    return ackPatterns.test(cleaned);
  }
  
  // RELEVANCE GATE: Validates if FAQ/product results actually match the user's query
  // Returns relevance score (0-100). Gate threshold is 40% - below this, route to fallback template
  private checkRelevance(
    userQuery: string, 
    result: { question?: string; answer?: string; name?: string; description?: string },
    resultType: 'faq' | 'product'
  ): { score: number; isRelevant: boolean; reason: string } {
    const RELEVANCE_THRESHOLD = 40; // Minimum score to consider result relevant
    
    const queryLower = userQuery.toLowerCase().trim();
    const queryWords = this.extractKeyTerms(queryLower);
    
    if (queryWords.length === 0) {
      return { score: 0, isRelevant: false, reason: 'No key terms in query' };
    }
    
    // Get text to match against based on result type
    let targetText = '';
    if (resultType === 'faq') {
      targetText = `${result.question || ''} ${result.answer || ''}`.toLowerCase();
    } else {
      targetText = `${result.name || ''} ${result.description || ''}`.toLowerCase();
    }
    
    // Calculate relevance score
    let score = 0;
    let matchedTerms: string[] = [];
    let missedHighPriorityTerms: string[] = [];
    
    for (const term of queryWords) {
      const weight = this.getTermWeight(term);
      if (targetText.includes(term)) {
        score += weight;
        matchedTerms.push(term);
      } else if (weight >= 15) {
        // Track missed high-priority terms
        missedHighPriorityTerms.push(term);
      }
    }
    
    // Normalize score to 0-100 range
    const maxPossibleScore = queryWords.reduce((sum, term) => sum + this.getTermWeight(term), 0);
    const normalizedScore = maxPossibleScore > 0 ? Math.round((score / maxPossibleScore) * 100) : 0;
    
    // Special case: If a high-priority domain term is missing, penalize heavily
    // E.g., user asks about "fee" but FAQ is about "duration" - that's a mismatch
    if (missedHighPriorityTerms.length > 0 && normalizedScore < 70) {
      const penalty = missedHighPriorityTerms.length * 15;
      const penalizedScore = Math.max(0, normalizedScore - penalty);
      return {
        score: penalizedScore,
        isRelevant: penalizedScore >= RELEVANCE_THRESHOLD,
        reason: `Missing key terms: ${missedHighPriorityTerms.join(', ')}. Matched: ${matchedTerms.join(', ') || 'none'}`
      };
    }
    
    return {
      score: normalizedScore,
      isRelevant: normalizedScore >= RELEVANCE_THRESHOLD,
      reason: `Matched ${matchedTerms.length}/${queryWords.length} terms: ${matchedTerms.join(', ') || 'none'}`
    };
  }
  
  // Extract key terms from a query, filtering out stopwords and short words
  private extractKeyTerms(query: string): string[] {
    const stopwords = new Set([
      'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
      'may', 'might', 'must', 'shall', 'can', 'need', 'dare', 'ought', 'used',
      'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into',
      'through', 'during', 'before', 'after', 'above', 'below', 'between',
      'and', 'but', 'or', 'nor', 'so', 'yet', 'both', 'either', 'neither',
      'not', 'only', 'own', 'same', 'than', 'too', 'very', 'just',
      'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'it', 'they', 'them',
      'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those',
      'am', 'about', 'also', 'how', 'why', 'when', 'where', 'please', 'tell', 'know',
      'want', 'like', 'get', 'give', 'show', 'find', 'help', 'looking'
    ]);
    
    const words = query
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length >= 2 && !stopwords.has(word));
    
    return Array.from(new Set(words)); // Remove duplicates
  }
  
  // Get weight for a term - domain-specific terms get higher weight
  private getTermWeight(term: string): number {
    // High-priority domain keywords (20 points) - these MUST match
    const highPriorityTerms = new Set([
      'fee', 'fees', 'price', 'pricing', 'cost', 'costs', 'payment', 'tuition',
      'duration', 'length', 'years', 'months', 'semesters',
      'eligibility', 'eligible', 'qualification', 'requirements', 'criteria',
      'admission', 'admissions', 'apply', 'application', 'enroll', 'enrollment',
      'scholarship', 'scholarships', 'discount', 'offer', 'offers',
      'syllabus', 'curriculum', 'subjects', 'courses', 'modules',
      'placement', 'placements', 'job', 'jobs', 'career', 'careers',
      'certificate', 'degree', 'diploma', 'certification',
      'accreditation', 'accredited', 'recognition', 'approved',
      'deadline', 'last', 'date', 'dates', 'schedule',
      'faculty', 'teachers', 'professors', 'instructors',
      'exam', 'exams', 'examination', 'test', 'tests', 'assessment'
    ]);
    
    // Medium-priority terms (10 points)
    const mediumPriorityTerms = new Set([
      'online', 'offline', 'distance', 'regular', 'part-time', 'full-time',
      'mba', 'bba', 'mca', 'bca', 'pgdm', 'diploma', 'bachelor', 'master',
      'specialization', 'specializations', 'stream', 'branch',
      'semester', 'year', 'batch', 'intake', 'session',
      'process', 'procedure', 'steps', 'documents', 'documentation',
      'support', 'contact', 'helpline', 'assistance'
    ]);
    
    // Low-priority generic terms (5 points) - these alone shouldn't match
    const lowPriorityTerms = new Set([
      'structure', 'system', 'program', 'programme', 'course',
      'information', 'details', 'about', 'regarding', 'related',
      'yearly', 'monthly', 'annual', 'total', 'complete'
    ]);
    
    if (highPriorityTerms.has(term)) return 20;
    if (mediumPriorityTerms.has(term)) return 10;
    if (lowPriorityTerms.has(term)) return 5;
    return 8; // Default weight for unknown terms
  }
  
  // Check if user message is a substantive question that needs knowledge base info
  private isSubstantiveQuestion(message: string): boolean {
    const trimmed = message.trim().toLowerCase();
    
    // Short greetings and small talk - NEVER substantive, always bypass
    const casualPatterns = [
      /^(hi|hey|hello|yo|sup|hiya|howdy)[\s!?.]*$/i,
      /^(good|gm|gn)\s*(morning|afternoon|evening|night)[\s!?.]*$/i,
      /^(how are you|what's up|wassup|whats up)[\s!?.]*$/i,
      /^(thanks|thank you|thx|ty)[\s!?.]*$/i,
      /^(ok|okay|sure|great|cool|nice|awesome)[\s!?.]*$/i,
      /^(bye|goodbye|see you|later|cya)[\s!?.]*$/i,
      /^(yes|no|yeah|yep|nope|nah)[\s!?.]*$/i,
    ];
    
    if (casualPatterns.some(pattern => pattern.test(trimmed))) {
      return false;
    }
    
    // Business-related keywords - these ARE substantive even if short
    // Comprehensive list covering common business inquiries
    const businessKeywords = [
      // Pricing & costs
      /price|pricing|cost|rate|fee|charge|payment/i,
      // Logistics & delivery
      /shipping|delivery|ship|track|tracking|dispatch/i,
      // Returns & refunds
      /return|refund|exchange|cancel|cancellation/i,
      // Warranties & guarantees
      /warranty|guarantee|repair|fix/i,
      // Availability & stock
      /stock|inventory|available|availability|in\s*stock|out\s*of\s*stock/i,
      // Promotions & discounts
      /discount|sale|offer|deal|promo|promotion|coupon/i,
      // Product details
      /size|sizing|dimension|measure|specification|specs/i,
      /material|fabric|made of|ingredients/i,
      /color|colour|style|design/i,
      /product|item|model|version|variant/i,
      // Purchasing & orders
      /order|purchase|buy|checkout|cart/i,
      // Contact & business info
      /contact|phone|email|address|location|hours|open|close|store/i,
      // Policies
      /policy|policies|terms|conditions/i,
      // Support & help
      /support|assist|help me|question|issue|problem/i,
      // Appointments & booking
      /appointment|book|booking|schedule|reserve|reservation|slot|time/i,
      // Services
      /service|services|consultation|quote|estimate/i,
      // Catalog & browsing
      /catalog|catalogue|menu|list|show me|browse/i,
      // Comparison & info
      /compare|comparison|difference|versus|vs\b|feature/i,
      // Membership & accounts
      /membership|account|register|sign up|login|member/i,
    ];
    
    if (businessKeywords.some(pattern => pattern.test(trimmed))) {
      return true;
    }
    
    // Check for question indicators (question marks, question words)
    const hasQuestionMark = trimmed.includes('?');
    const hasQuestionWord = /^(what|where|when|who|why|how|can|could|would|is|are|do|does|will|should)/i.test(trimmed);
    const hasInquiryPhrase = /(tell me|explain|describe|show me|looking for|need|want to know)/i.test(trimmed);
    
    // If it's clearly a question, it's substantive
    if (hasQuestionMark || hasQuestionWord || hasInquiryPhrase) {
      return true;
    }
    
    // Longer messages (>15 chars) that aren't casual are likely substantive
    return trimmed.length > 15;
  }

  // Helper method to auto-categorize questions
  private categorizeQuestion(question: string): string {
    const lowerQuestion = question.toLowerCase();
    
    if (lowerQuestion.includes('price') || lowerQuestion.includes('cost') || lowerQuestion.includes('how much')) {
      return 'Pricing';
    }
    if (lowerQuestion.includes('feature') || lowerQuestion.includes('what is') || lowerQuestion.includes('what are')) {
      return 'Features';
    }
    if (lowerQuestion.includes('how') || lowerQuestion.includes('setup') || lowerQuestion.includes('configure')) {
      return 'Technical';
    }
    if (lowerQuestion.includes('when') || lowerQuestion.includes('delivery') || lowerQuestion.includes('shipping')) {
      return 'Logistics';
    }
    
    return 'General';
  }

  // Helper method to save unanswered question to Question Bank
  private async saveToQuestionBank(
    businessAccountId: string,
    conversationId: string,
    userMessage: string,
    aiResponse: string,
    messageId?: string
  ): Promise<void> {
    try {
      await storage.createQuestionBankEntry({
        businessAccountId,
        conversationId,
        messageId: messageId || null,
        question: userMessage,
        aiResponse,
        userContext: null,
        status: 'new',
        category: this.categorizeQuestion(userMessage),
        confidenceScore: null,
      });
      console.log('[Question Bank] Auto-saved unanswered question:', userMessage.substring(0, 50));
    } catch (error) {
      console.error('[Question Bank] Error saving to question bank:', error);
    }
  }

  // INSTANT PROGRESSIVE LEAD CAPTURE: Backend auto-detection
  // Deterministically captures phone/email from messages to ensure zero data loss
  // Works alongside AI tool calls as a safety net
  private async autoDetectAndCaptureLead(
    userMessage: string,
    conversationId: string,
    businessAccountId: string,
    lastAIMessage?: string,
    visitorCity?: string,
    visitorSessionId?: string,
    pageUrl?: string
  ): Promise<void> {
    try {
      // Get widget settings to check phone validation config
      const widgetSettings = await storage.getWidgetSettings(businessAccountId);
      const leadConfig = widgetSettings?.leadTrainingConfig as any;
      
      // Get phone validation setting (check mobile field first, then whatsapp)
      let phoneValidation: '10' | '12' | '8-12' | 'any' = '10'; // Default to 10 digits
      if (leadConfig?.fields && Array.isArray(leadConfig.fields)) {
        const mobileField = leadConfig.fields.find((f: any) => f.id === 'mobile' && f.enabled);
        const whatsappField = leadConfig.fields.find((f: any) => f.id === 'whatsapp' && f.enabled);
        if (mobileField?.phoneValidation) {
          phoneValidation = mobileField.phoneValidation;
        } else if (whatsappField?.phoneValidation) {
          phoneValidation = whatsappField.phoneValidation;
        }
      }
      
      // Enhanced phone number detection: finds phone numbers WITHIN messages
      // Matches patterns like: "9876543210", "+91-9876543210", "call me at 987 654 3210", "My phone is 9999999999"
      // First, try to find phone-like patterns in the message (8-20 chars with digits, spaces, dashes, parens)
      const phonePattern = /\+?[\d\s().-]{8,20}/g;
      const phoneMatches = userMessage.match(phonePattern);
      
      let detectedPhone: string | null = null;
      
      if (phoneMatches && phoneMatches.length > 0) {
        // Clean each match and validate based on phoneValidation setting
        for (const match of phoneMatches) {
          const cleaned = match.replace(/[^\d+]/g, ''); // Keep only digits and +
          // Get only the digits (without +) for counting
          const digitsOnly = cleaned.replace(/\+/g, '');
          
          // Validate based on phoneValidation setting
          let isValid = false;
          switch (phoneValidation) {
            case '10':
              isValid = digitsOnly.length === 10;
              break;
            case '12':
              isValid = digitsOnly.length === 12;
              break;
            case '8-12':
              isValid = digitsOnly.length >= 8 && digitsOnly.length <= 12;
              break;
            case 'any':
              isValid = digitsOnly.length >= 7 && digitsOnly.length <= 15;
              break;
            default:
              isValid = digitsOnly.length === 10;
          }
          
          if (isValid) {
            const junkCheck = validatePhoneNumber(digitsOnly, phoneValidation as any);
            if (!junkCheck.isValid) {
              console.log(`[Auto Lead Capture] Junk phone rejected: ${digitsOnly} - ${junkCheck.reasonMessage}`);
              continue;
            }
            detectedPhone = cleaned;
            break; // Take first valid phone number
          }
        }
      }
      
      console.log('[Auto Lead Capture] Checking message:', userMessage, '| Phone match:', !!detectedPhone, detectedPhone || '', '| Validation:', phoneValidation);
      
      // Email pattern
      const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
      const emailMatch = userMessage.match(emailPattern);
      
      // Enhanced name detection - handles both explicit and standalone names
      // Pattern 1: "My name is [name]" - explicit name introduction
      // Pattern 2: Standalone short alphabetic responses (likely names in conversational context)
      let detectedName: string | null = null;
      
      // First try explicit "my name is" pattern
      const myNameIsPattern = /\bmy name is\s+(.+)/i;
      const myNameMatch = userMessage.match(myNameIsPattern);
      
      if (myNameMatch && myNameMatch[1]) {
        // Extract all words after "my name is"
        const afterNameIs = myNameMatch[1].trim();
        
        // Split on ANY non-letter character (space, comma, punctuation, etc.)
        const tokens = afterNameIs.split(/[^a-z'-]+/i).filter(t => t.length > 0);
        
        if (tokens.length > 0) {
          // Take only first 1-2 tokens that look like names
          const firstToken = tokens[0];
          const secondToken = tokens.length > 1 ? tokens[1] : null;
          
          // Basic validation: not a common non-name word
          const nonNameWords = ['i', 'am', 'interested', 'looking', 'need', 'want', 'have', 'yes', 'no', 'ok', 'okay', 'sure', 'hello', 'hi', 'hey', 'thanks', 'thank'];
          
          if (!nonNameWords.includes(firstToken.toLowerCase())) {
            // Accept first token
            let nameParts = [firstToken];
            
            // Accept second token if it exists and also looks like a name
            if (secondToken && !nonNameWords.includes(secondToken.toLowerCase()) && secondToken.length >= 2) {
              nameParts.push(secondToken);
            }
            
            // Capitalize and join
            detectedName = nameParts.map(w => 
              w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
            ).join(' ');
          }
        }
      }
      
      // If not found via "my name is", try CONTEXT-AWARE standalone name detection
      // Only detect standalone names if AI recently asked for the user's name
      // This prevents false positives like "cool", "awesome", "thanks" from being detected as names
      if (!detectedName && lastAIMessage) {
        // Check if the last AI message was asking for the user's PERSONAL name
        // Be very specific to avoid matching "company name", "product name", etc.
        const nameRequestPatterns = [
          /\bwhat'?s your name\b/i,
          /\byour name\?/i, // "And your name?" or "Your name please?"
          /\bmay i (have|know|get) your name\b/i,
          /\bcould you (tell|give|share) me your name\b/i,
          /\bcan i (have|know|get) your name\b/i,
          /\bplease (provide|share|give|tell) (me )?your name\b/i,
          /\bmay i please have your name\b/i,
          /\bwhat should i call you\b/i,
          /\bhow should i address you\b/i
        ];
        
        const aiAskedForName = nameRequestPatterns.some(pattern => pattern.test(lastAIMessage));
        
        // Only proceed with standalone name detection if AI asked for name
        if (aiAskedForName) {
          const trimmed = userMessage.trim();
          // Must be short (1-3 words max), only alphabetic chars + spaces/hyphens/apostrophes
          const standaloneNamePattern = /^[a-z][a-z'\-\s]{0,40}$/i;
          
          if (standaloneNamePattern.test(trimmed)) {
            const words = trimmed.split(/\s+/).filter(w => w.length > 0);
            
            // Only accept 1-3 words (not 4+, too risky for false positives)
            if (words.length >= 1 && words.length <= 3) {
              // Comprehensive list of common non-name words to filter out
              const nonNameWords = [
                // Pronouns & common words
                'i', 'me', 'my', 'you', 'your', 'he', 'she', 'it', 'we', 'they', 'them',
                // Verbs (including 2-char ones)
                'am', 'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has', 'had', 'do', 'does', 'did',
                'want', 'need', 'like', 'love', 'hate', 'know', 'think', 'see', 'look', 'get', 'got', 'go',
                // Common responses (including 2-char ones)
                'yes', 'no', 'ok', 'okay', 'sure', 'maybe', 'yep', 'nope', 'yeah', 'nah',
                // Greetings & pleasantries
                'hello', 'hi', 'hey', 'thanks', 'thank', 'please', 'sorry', 'bye', 'goodbye',
                // Articles & prepositions
                'the', 'a', 'an', 'this', 'that', 'these', 'those', 'of', 'to', 'for', 'in', 'on', 'at',
                // Adjectives & casual words
                'good', 'bad', 'great', 'nice', 'fine', 'interested', 'looking', 'here', 'there',
                'cool', 'awesome', 'wow', 'yo', 'dude', 'bro',
                // Additional 2-char common words to block
                'or', 'so', 'up', 'us', 'if', 'as', 'by'
              ];
              
              // Each word must be:
              // 1. At least 2 characters (allows short names like "Li", "Jo", "Ng")
              // 2. Not in the comprehensive stop-word list
              const validWords = words.filter(w => 
                w.length >= 2 && 
                !nonNameWords.includes(w.toLowerCase())
              );
              
              // Only accept if ALL words passed the filter AND we have 1-2 valid words
              if (validWords.length >= 1 && validWords.length <= 2 && validWords.length === words.length) {
                // Capitalize and join
                detectedName = validWords.map(w => 
                  w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
                ).join(' ');
                
                console.log('[Auto Lead Capture] Context-aware standalone name detected:', detectedName);
              }
            }
          }
        }
      }
      
      // Check if we detected any contact info (detectedPhone already set above)
      const detectedEmail = emailMatch ? emailMatch[0] : null;
      
      if (!detectedPhone && !detectedEmail && !detectedName) {
        return; // No contact info detected
      }
      
      console.log('[Auto Lead Capture] Detected contact info:', {
        phone: detectedPhone,
        email: detectedEmail,
        name: detectedName
      });
      
      // Load Smart Lead Training configuration to enforce required fields
      let requiredFields: string[] = [];
      try {
        const widgetSettings = await storage.getWidgetSettings(businessAccountId);
        if (widgetSettings?.leadTrainingConfig) {
          const leadConfig = widgetSettings.leadTrainingConfig as any;
          if (leadConfig.fields && Array.isArray(leadConfig.fields)) {
            // Supported field IDs that can be auto-detected
            const supportedFieldIds = ['name', 'email', 'phone', 'mobile', 'whatsapp'];
            
            requiredFields = leadConfig.fields
              .filter((f: any) => f && f.enabled === true && f.required === true)
              .map((f: any) => f.id)
              .filter((id: string) => supportedFieldIds.includes(id)); // Sanitize: only keep supported fields
            
            const rawRequiredFields = leadConfig.fields
              .filter((f: any) => f && f.enabled === true && f.required === true)
              .map((f: any) => f.id);
            
            const unsupportedFields = rawRequiredFields.filter((id: string) => !supportedFieldIds.includes(id));
            if (unsupportedFields.length > 0) {
              console.warn(`[Auto Lead Capture] Ignoring unsupported required fields: ${unsupportedFields.join(', ')}`);
            }
          }
        }
      } catch (error) {
        console.error('[Auto Lead Capture] Error loading leadTrainingConfig:', error);
      }

      // Check if a lead already exists for this conversation
      const existingLead = await storage.getLeadByConversation(conversationId, businessAccountId);
      
      if (existingLead) {
        // Update existing lead with new info (progressive enrichment allowed)
        const updateData: any = {};
        if (detectedPhone && (!existingLead.phone || existingLead.phone !== detectedPhone)) {
          updateData.phone = detectedPhone;
        }
        if (detectedEmail && (!existingLead.email || existingLead.email !== detectedEmail)) {
          updateData.email = detectedEmail;
        }
        if (detectedName && (!existingLead.name || existingLead.name === 'Anonymous')) {
          updateData.name = detectedName;
        }
        
        if (Object.keys(updateData).length > 0) {
          await storage.updateLead(existingLead.id, businessAccountId, updateData);
          console.log(`[Auto Lead Capture] Updated lead ${existingLead.id} with:`, updateData);
          
          // Update conversation title
          const newTitle = updateData.name || detectedName || existingLead.name || detectedPhone || existingLead.phone || detectedEmail || 'Anonymous';
          if (newTitle !== 'Anonymous') {
            await storage.updateConversationTitle(conversationId, businessAccountId, newTitle);
          }
          
          // Sync update to LeadSquared (async, non-blocking) - only send changed fields
          // IMPORTANT: Only sync if we have at least phone OR email (LeadSquared rejects name-only leads)
          const hasPhoneOrEmail = (updateData.phone || existingLead.phone) || (updateData.email || existingLead.email);
          if (hasPhoneOrEmail) {
            this.syncLeadToLeadSquared({
              id: existingLead.id,
              name: updateData.name || existingLead.name,
              email: updateData.email || existingLead.email,
              phone: updateData.phone || existingLead.phone,
              leadsquaredLeadId: existingLead.leadsquaredLeadId
            }, businessAccountId, true, Object.keys(updateData)).catch(err => console.error('[LeadSquared] Background sync error:', err));
          } else {
            console.log('[LeadSquared] Skipping sync - no phone or email yet (name-only leads not supported)');
          }
        }
      } else {
        // Creating NEW lead - enforce Smart Lead Training required field validation
        // Build field mapping from detected contact info
        // Note: detectedPhone satisfies phone/mobile/whatsapp (all are phone numbers)
        const fieldMap: Record<string, string | null> = {
          name: detectedName,
          email: detectedEmail,
          phone: detectedPhone,
          mobile: detectedPhone, // phone satisfies mobile requirement
          whatsapp: detectedPhone // phone satisfies whatsapp requirement
        };

        // INSTANT PROGRESSIVE CAPTURE: Create lead immediately with whatever we have
        // Don't block on missing required fields - save partial data to prevent loss
        if (detectedPhone || detectedEmail || detectedName) {
          console.log(`[Auto Lead Capture - Progressive] Creating partial lead with: ${[detectedName && 'name', detectedPhone && 'phone', detectedEmail && 'email'].filter(Boolean).join(', ')}`);
          
          // Check which required fields are still missing (for logging only)
          const missingFields = requiredFields.filter(fieldId => {
            const fieldValue = fieldMap[fieldId];
            return !fieldValue || fieldValue.trim() === '';
          });
          
          if (missingFields.length > 0) {
            console.log(`[Auto Lead Capture - Progressive] Partial lead - missing required fields: ${missingFields.join(', ')} (will be collected later)`);
          }
          
          let sourceUrl: string | null = pageUrl || null;
          
          // Create the partial lead immediately
          const newLead = await storage.createLead({
            businessAccountId,
            name: detectedName || null,
            email: detectedEmail || null,
            phone: detectedPhone || null,
            city: visitorCity || null,
            sourceUrl,
            message: 'Via Chat',
            conversationId
          });
          console.log(`[Auto Lead Capture] Created new lead ${newLead.id} with:`, {
            name: detectedName,
            phone: detectedPhone,
            email: detectedEmail
          });
          
          // Update conversation title
          const newTitle = detectedName || detectedPhone || detectedEmail || 'Anonymous';
          if (newTitle !== 'Anonymous') {
            await storage.updateConversationTitle(conversationId, businessAccountId, newTitle);
          }
          
          // Sync new lead to LeadSquared (async, non-blocking)
          // IMPORTANT: Only sync if we have at least phone OR email (LeadSquared rejects name-only leads)
          if (detectedPhone || detectedEmail) {
            this.syncLeadToLeadSquared({
              id: newLead.id,
              name: detectedName,
              email: detectedEmail,
              phone: detectedPhone
            }, businessAccountId, false).catch(err => console.error('[LeadSquared] Background sync error:', err));
          } else {
            console.log('[LeadSquared] Skipping new lead sync - no phone or email yet (name-only leads not supported)');
          }
        }
      }
    } catch (error) {
      console.error('[Auto Lead Capture] Error:', error);
    }
  }

  // Sync a lead to LeadSquared CRM (async, non-blocking)
  // Called when a lead is created or updated during chat
  private async syncLeadToLeadSquared(
    lead: { id: string; name?: string | null; email?: string | null; phone?: string | null; leadsquaredLeadId?: string | null },
    businessAccountId: string,
    isUpdate: boolean = false,
    changedFields?: string[]
  ): Promise<void> {
    try {
      // Check if LeadSquared integration is enabled
      const settings = await storage.getWidgetSettings(businessAccountId);
      if (!settings?.leadsquaredEnabled || settings.leadsquaredEnabled !== 'true') {
        return; // Auto-sync not enabled
      }
      
      if (!settings.leadsquaredAccessKey || !settings.leadsquaredSecretKey || !settings.leadsquaredRegion) {
        console.log('[LeadSquared] Auto-sync enabled but credentials not configured');
        return;
      }
      
      // Decrypt the stored secret key (it's encrypted in the database)
      const { decrypt } = await import('./services/encryptionService');
      let decryptedSecretKey: string;
      try {
        decryptedSecretKey = decrypt(settings.leadsquaredSecretKey);
      } catch (decryptError) {
        console.error('[LeadSquared] Failed to decrypt secret key:', decryptError);
        return;
      }
      
      // Import and create LeadSquared service
      const { createLeadSquaredService, extractUtmCampaign, extractUtmSource, extractUtmMedium } = await import('./services/leadsquaredService');
      const leadsquaredService = await createLeadSquaredService({
        accessKey: settings.leadsquaredAccessKey,
        secretKey: decryptedSecretKey,
        region: settings.leadsquaredRegion as 'india' | 'us' | 'other',
        customHost: settings.leadsquaredCustomHost || undefined
      });
      
      // Get business account info for additional fields
      const businessAccount = await storage.getBusinessAccount(businessAccountId);
      
      // Get full lead details from database for city and createdAt
      const fullLead = await storage.getLead(lead.id, businessAccountId);
      
      // Get field mappings from database (dynamic, configurable)
      const fieldMappings = await storage.getLeadsquaredFieldMappings(businessAccountId);
      
      let urlExtraction: { university?: string | null; product?: string | null } | undefined;
      const needsUrlExtraction = fieldMappings.some(m => m.isEnabled === 'true' && m.sourceType === 'dynamic' && m.sourceField?.startsWith('urlLookup.'));
      const effectiveSourceUrl = fullLead?.sourceUrl || null;
      if (needsUrlExtraction && effectiveSourceUrl) {
        try {
          const { extractProductFromUrl } = await import('./services/urlExtractionService');
          const extractionConfig = {
            domain: settings.lsqExtractionDomain || null,
            universities: settings.lsqExtractionUniversities || null,
            products: settings.lsqExtractionProducts || null,
            fallbackUniversity: settings.lsqExtractionFallbackUniversity || null,
            fallbackProduct: settings.lsqExtractionFallbackProduct || null,
          };
          urlExtraction = await extractProductFromUrl(effectiveSourceUrl, businessAccountId, extractionConfig);
          console.log('[LeadSquared Chat Sync] URL extraction result:', urlExtraction);
        } catch (extractErr) {
          console.warn('[LeadSquared Chat Sync] URL extraction failed:', extractErr);
        }
      }

      const leadContext = {
        lead: {
          name: lead.name || fullLead?.name || null,
          email: lead.email || fullLead?.email || null,
          phone: lead.phone || fullLead?.phone || null,
          whatsapp: fullLead?.whatsapp || null,
          createdAt: fullLead?.createdAt || null,
          sourceUrl: fullLead?.sourceUrl || null,
        },
        session: {
          city: fullLead?.city || null,
          utmCampaign: extractUtmCampaign(fullLead?.sourceUrl) || null,
          utmSource: extractUtmSource(fullLead?.sourceUrl) || null,
          utmMedium: extractUtmMedium(fullLead?.sourceUrl) || null,
          pageUrl: fullLead?.sourceUrl || null,
        },
        business: {
          name: businessAccount?.name || null,
          website: businessAccount?.website || null,
        },
        ...(urlExtraction ? { urlExtraction } : {}),
      };
      
      console.log('[LeadSquared] Auto-sync using dynamic field mappings, count:', fieldMappings.length);
      
      // If it's an update AND we have a LeadSquared ID, update existing record
      if (isUpdate && lead.leadsquaredLeadId) {
        console.log('[LeadSquared] Auto-syncing lead update:', lead.id, '→', lead.leadsquaredLeadId);
        const result = await leadsquaredService.updateLeadWithMappings(lead.leadsquaredLeadId, fieldMappings, leadContext, changedFields);
        
        if (result.success) {
          await storage.updateLead(lead.id, businessAccountId, {
            leadsquaredSyncStatus: 'synced',
            leadsquaredSyncedAt: new Date(),
            leadsquaredSyncPayload: result.syncPayload || null
          });
          console.log('[LeadSquared] Lead update synced successfully:', lead.id);
        } else {
          console.error('[LeadSquared] Lead update sync failed:', lead.id, result.message);
          await storage.updateLead(lead.id, businessAccountId, {
            leadsquaredSyncStatus: 'failed',
            leadsquaredSyncError: result.message
          });
        }
      } else {
        // Create new lead in LeadSquared (either new lead OR existing lead without LeadSquared ID)
        const action = isUpdate ? 'syncing existing unsynced lead' : 'syncing new lead';
        console.log(`[LeadSquared] Auto-${action}:`, lead.id);
        const result = await leadsquaredService.createLeadWithMappings(fieldMappings, leadContext);
        
        if (result.success && result.leadId) {
          await storage.updateLead(lead.id, businessAccountId, {
            leadsquaredLeadId: result.leadId,
            leadsquaredSyncStatus: 'synced',
            leadsquaredSyncedAt: new Date(),
            leadsquaredSyncPayload: result.syncPayload || null
          });
          console.log('[LeadSquared] Lead synced successfully:', lead.id, '→', result.leadId);
        } else {
          console.error('[LeadSquared] Lead sync failed:', lead.id, result.message);
          await storage.updateLead(lead.id, businessAccountId, {
            leadsquaredSyncStatus: 'failed',
            leadsquaredSyncError: result.message
          });
        }
      }
    } catch (error: any) {
      console.error('[LeadSquared] Auto-sync error:', error);
      // Don't throw - sync is non-blocking
    }
  }

  // Public method to prewarm cache for a business account
  // This loads all business context into cache without processing a message
  async prewarmCache(context: ChatContext): Promise<void> {
    try {
      console.log(`[Cache Prewarm] Starting cache warm for business: ${context.businessAccountId}`);
      const startTime = Date.now();
      
      // Trigger cache loading by calling buildEnrichedContext
      await this.buildEnrichedContext(context);
      
      const duration = Date.now() - startTime;
      console.log(`[Cache Prewarm] Cache warmed successfully in ${duration}ms`);
    } catch (error) {
      console.error('[Cache Prewarm] Error warming cache:', error);
      // Don't throw - this is fire-and-forget
    }
  }

  async processMessage(userMessage: string, context: ChatContext): Promise<string> {
    try {
      // Get conversation history to check if this is a new conversation
      const existingHistory = conversationMemory.getConversationHistory(context.userId);
      const isFirstMessage = existingHistory.length === 0;
      
      // SPAM DETECTION: Check first message - if spam, use simplified path (no DB, no journeys, just AI response)
      // Skip spam check for resume uploads — they must go through the full AI flow
      if (isFirstMessage && context.openaiApiKey && !userMessage.startsWith('[RESUME_UPLOAD]') && !userMessage.startsWith('[JOB_APPLY]') && !context.resumeText) {
        const spamCheck = await isGibberishAI(userMessage, context.openaiApiKey);
        if (spamCheck.isSpam && spamCheck.confidence === 'high') {
          console.log('[Chat] Spam detected (processMessage) - using simplified response path:', userMessage.substring(0, 50));
          
          // Store in memory only (no DB)
          conversationMemory.storeMessage(context.userId, 'user', userMessage);
          
          // Call AI directly with minimal context - let it respond naturally
          const response = await this.getSimpleAIResponse(userMessage, context);
          conversationMemory.storeMessage(context.userId, 'assistant', response);
          
          return response;
        }
      }
      
      // Get or create conversation (normal flow)
      const conversationId = await this.getOrCreateConversation(context);
      
      // Get conversation history to check if AI recently asked for name
      const history = conversationMemory.getConversationHistory(context.userId);
      const lastAIMessage = history.length > 0 && history[history.length - 1].role === 'assistant' 
        ? history[history.length - 1].content 
        : undefined;
      
      // CRITICAL: Capture lead state BEFORE auto-detection to compare after
      // This allows us to detect if required fields JUST became complete
      const leadBeforeCaptureRaw = await storage.getLeadByConversation(conversationId, context.businessAccountId);
      const leadBeforeCapture = leadBeforeCaptureRaw ? { 
        phone: leadBeforeCaptureRaw.phone, 
        email: leadBeforeCaptureRaw.email, 
        name: leadBeforeCaptureRaw.name 
      } : null;
      
      // Auto-detect and capture contact information from user message
      // This ensures leads are captured even if AI doesn't call the capture_lead tool
      await this.autoDetectAndCaptureLead(userMessage, conversationId, context.businessAccountId, lastAIMessage, context.visitorCity, context.visitorSessionId, context.pageUrl);
      
      // PERFORMANCE: Early check if business has any active journeys
      // Skip all journey processing if no journeys exist for this account
      const hasActiveJourneys = await journeyService.hasActiveJourneys(context.businessAccountId);
      let isJourneyActive = false;
      
      if (hasActiveJourneys) {
        // Auto-inject journey conversational guidelines if not already provided and if journey is active
        if (!context.journeyConversationalGuidelines) {
          const activeJourneyState = await journeyService.getJourneyState(conversationId);
          if (activeJourneyState && !activeJourneyState.completed) {
            const journey = await storage.getJourney(activeJourneyState.journeyId, context.businessAccountId);
            if (journey && journey.conversationalGuidelines) {
              // Parse journey instructions from JSON array and format as string
              try {
                const instructions = JSON.parse(journey.conversationalGuidelines);
                if (Array.isArray(instructions) && instructions.length > 0) {
                  context.journeyConversationalGuidelines = instructions
                    .map((inst: any, index: number) => `${index + 1}. ${inst.text}`)
                    .join('\n');
                }
              } catch {
                // Legacy format - use as-is if not JSON
                context.journeyConversationalGuidelines = journey.conversationalGuidelines;
              }
            }
          }
        }
      }
      
      // Store user message in memory and database
      conversationMemory.storeMessage(context.userId, 'user', userMessage);
      await this.storeMessageInDB(conversationId, 'user', userMessage);

      if (userMessage.startsWith('[JOB_APPLY]')) {
        const applyMatch = userMessage.match(/\|jobId:([^|]+)\|applicantId:([^|]+)/);
        const clientJobTitle = userMessage.replace(/^\[JOB_APPLY\]\s*/, '').replace(/\s*\|jobId:.*$/, '').trim();
        if (applyMatch) {
          const jobId = applyMatch[1].trim();
          const applicantId = applyMatch[2].trim();
          console.log(`[Chat processMessage] JOB_APPLY intercept: jobId=${jobId}, applicantId=${applicantId}, title="${clientJobTitle}"`);
          try {
            const result = await ToolExecutionService.executeTool(
              'apply_to_job',
              { jobId, applicantId },
              {
                businessAccountId: context.businessAccountId,
                userId: context.userId,
                conversationId: conversationId,
                visitorCity: context.visitorCity,
                userMessage: userMessage,
                selectedLanguage: context.preferredLanguage
              },
              userMessage,
              false
            );
            const resultData = result.success && 'data' in result && result.data ? result.data : {};
            const serverTitle = resultData.jobTitle || clientJobTitle;
            const reply = result.success
              ? `Your application for **${serverTitle}** has been submitted successfully! The hiring team will review your profile and get back to you soon.`
              : `Sorry, I couldn't submit your application. ${result.message || 'Please try again.'}`;
            conversationMemory.storeMessage(context.userId, 'assistant', reply);
            await this.storeMessageInDB(conversationId, 'assistant', reply);
            return reply;
          } catch (err) {
            console.error('[Chat] JOB_APPLY error:', err);
            const errReply = `Sorry, something went wrong while submitting your application. Please try again.`;
            conversationMemory.storeMessage(context.userId, 'assistant', errReply);
            await this.storeMessageInDB(conversationId, 'assistant', errReply);
            return errReply;
          }
        } else {
          const errReply = 'Sorry, the application request was malformed. Please try clicking Apply Now again.';
          conversationMemory.storeMessage(context.userId, 'assistant', errReply);
          await this.storeMessageInDB(conversationId, 'assistant', errReply);
          return errReply;
        }
      }

      try {
        const { getSmartReplyResponse } = await import('./services/smartReplyService');
        const smartReply = await getSmartReplyResponse(context.businessAccountId, "website", userMessage);
        if (smartReply) {
          console.log(`[Chat] Smart reply matched: "${smartReply.matchedKeyword}" — returning configured response directly (skipping AI)`);
          conversationMemory.storeMessage(context.userId, 'assistant', smartReply.text);
          await this.storeMessageInDB(conversationId, 'assistant', smartReply.text);
          return smartReply.text;
        }
      } catch (err) {
        console.error("[Chat] Smart reply error (non-fatal):", err);
      }

      // Only process journeys if business has active journeys configured
      if (hasActiveJourneys) {
        // ENGINE-DRIVEN MODE: Try processing through journey engine first
        const engineResult = await journeyOrchestrator.processUserMessageEngineDriven(
          conversationId,
          context.userId,
          context.businessAccountId,
          userMessage
        );

        // If engine handled the message, return engine's response immediately
        if (engineResult.shouldBypassAI && engineResult.response) {
          console.log('[Chat] Engine-driven journey handled message - bypassing AI');
          
          // Store engine's response
          conversationMemory.storeMessage(context.userId, 'assistant', engineResult.response);
          await this.storeMessageInDB(conversationId, 'assistant', engineResult.response);
          
          return engineResult.response;
        }

        // Fall back to AI-guided journey (if enabled) or normal chat
        const journeyResult = await journeyOrchestrator.processUserMessage(
          conversationId,
          context.userId,
          context.businessAccountId,
          userMessage
        );
        isJourneyActive = journeyResult.isJourneyActive;
      } else {
        console.log('[Chat] No active journeys for business - skipping journey processing');
      }
      
      // Build enriched system context with company info and all FAQs
      // This includes PDF summaries and key points - should answer most questions
      let systemContext = await this.buildEnrichedContext(context);

      // Run RAG search and DB fetches in parallel — they are fully independent
      // RAG embedding call (~200ms) now overlaps with DB reads (~50ms) instead of preceding them
      console.log('[RAG] Running document chunk search for query');
      const [ragContext, [businessAccount, widgetSettings, existingLead, products]] = await Promise.all([
        this.addRAGContext(userMessage, context.businessAccountId),
        Promise.all([
          storage.getBusinessAccount(context.businessAccountId),
          storage.getWidgetSettings(context.businessAccountId),
          storage.getLeadByConversation(conversationId, context.businessAccountId),
          storage.getAllProducts(context.businessAccountId)
        ])
      ]);
      systemContext += ragContext;

      if (context.resumeText) {
        systemContext += `\n\n=== RESUME UPLOADED BY VISITOR ===\nThe visitor has uploaded their resume. You MUST call the parse_resume_and_match tool to analyze it and find matching jobs.\n---RESUME_TEXT---\n${context.resumeText.substring(0, 8000)}\n=== END RESUME ===\n`;
        console.log(`[Chat ProcessMessage] Resume text injected into system context (${context.resumeText.length} chars)`);
      }

      try {
        if (existingLead && (existingLead.phone || existingLead.email)) {
          const platformUserId = context.visitorToken || conversationId;
          const profile = await resolveProfile(context.businessAccountId, {
            phone: existingLead.phone || null,
            email: existingLead.email || null,
            name: existingLead.name || null,
            city: context.visitorCity || null,
            platform: "website",
            platformUserId,
          });
          if (profile) {
            const isFirstMsg = !history.some((m: any) => m.role === 'assistant');
            const crossPlatformCtx = await composeCrossPlatformContext(context.businessAccountId, "website", profile.id, isFirstMsg);
            if (crossPlatformCtx) {
              systemContext += `\n\n${crossPlatformCtx}`;
              console.log(`[Chat] Cross-platform context injected (${crossPlatformCtx.length} chars, firstMsg: ${isFirstMsg})`);
            }
            triggerSnapshotUpdate(context.businessAccountId, profile.id, "website", platformUserId);
          }
        }
      } catch (err) {
        console.error("[Chat] Cross-platform context error (non-fatal):", err);
      }

      // Appointments are enabled only if BOTH business account AND widget settings allow it
      const appointmentsEnabled = 
        businessAccount?.appointmentsEnabled === 'true' && 
        widgetSettings?.appointmentBookingEnabled === 'true';

      // Check if business has products - only include product tool if products exist
      const hasProducts = products.length > 0;

      // PHONE VALIDATION GATE (non-streaming path) — uses shared utility
      let phoneValidationFailedNS = false;
      let phoneValidationContextNS = '';
      const leadTrainingConfigNonStream = widgetSettings?.leadTrainingConfig as any;
      if (leadTrainingConfigNonStream) {
        const validationOverrideNS = buildPhoneValidationOverride(userMessage, leadTrainingConfigNonStream);
        if (validationOverrideNS) {
          phoneValidationFailedNS = true;
          phoneValidationContextNS = validationOverrideNS;
        }
      }

      // AI-GUIDED JOURNEYS: Check if journey is active and include journey tools
      // This allows AI to intelligently manage journeys while staying conversational
      // Pass conversation history to detect ongoing appointment context
      // Pass API key for AI-based product intent classification fallback
      const relevantTools = await selectRelevantTools(userMessage, appointmentsEnabled, isJourneyActive, hasProducts, history, context.openaiApiKey || undefined, context.systemMode, context.k12EducationEnabled, context.jobPortalEnabled);

      // Get AI response with tool awareness
      // Phone validation: pass as last-position system message override (highest GPT attention weight)
      const aiResponse = await llamaService.generateToolAwareResponse(
        userMessage,
        relevantTools,
        history,
        systemContext,
        context.personality || 'friendly',
        context.openaiApiKey || undefined,
        context.businessAccountId,
        hasProducts,
        context.responseLength || 'balanced',
        phoneValidationFailedNS ? phoneValidationContextNS : undefined
      );

      // Log tool calls for debugging
      console.log('[Chat] User message:', userMessage);
      console.log('[Chat] Tool calls received:', aiResponse.tool_calls ? aiResponse.tool_calls.length : 0);
      if (aiResponse.tool_calls) {
        aiResponse.tool_calls.forEach((tc: any) => {
          console.log('[Chat] Tool:', tc.function.name, 'Args:', tc.function.arguments);
        });
      }

      // Handle tool calls if any
      if (aiResponse.tool_calls && aiResponse.tool_calls.length > 0) {
        const result = await this.handleToolCalls(aiResponse, context, userMessage, relevantTools, appointmentsEnabled, false, systemContext);
        
        // DEFLECTION GATE: Check if response is a deflection and route to fallback template
        if (this.isDeflectionResponse(result.response) || result.response.includes('[[FALLBACK]]')) {
          console.log('[Deflection Gate] handleToolCalls returned deflection, routing to fallback template');
          const fallbackInstructions = this.fallbackInstructionsCache.get(context.businessAccountId);
          
          // Use custom fallback template if available, otherwise use a sensible default
          let fallbackTemplate = fallbackInstructions && fallbackInstructions.length > 0
            ? fallbackInstructions[0]
            : "I'll need to check with our team for the specific details. Could you please share your contact information so they can reach out to you?";
          
          fallbackTemplate = this.processFallbackPlaceholders(fallbackTemplate, existingLead);
          const rephrased = await this.rephraseFallbackMessage(
            fallbackTemplate,
            userMessage,
            context.businessAccountId,
            context.openaiApiKey || undefined,
            existingLead
          );
          // Update stored message with the rephrased fallback
          conversationMemory.storeMessage(context.userId, 'assistant', rephrased);
          await this.storeMessageInDB(conversationId, 'assistant', rephrased);
          return rephrased;
        }
        
        // Return just the response text
        return result.response;
      }

      // CRITICAL: Check if lead collection just completed WITHOUT the AI calling tools
      // This happens when user provides contact info and autoDetectAndCaptureLead saves it
      const leadStatus = await this.checkLeadCompletionStatus(conversationId, context.businessAccountId, widgetSettings, leadBeforeCapture);
      
      if (leadStatus.justCompleted) {
        // Extract the original user question (including current message in search)
        const originalQuestion = this.extractLastSubstantiveQuestion(history, userMessage);
        
        console.log('[Lead Completion] All required fields collected via auto-detection');
        console.log('[Lead Completion] Original question:', originalQuestion);
        
        if (originalQuestion) {
          // Inject instruction to answer the original question
          const postLeadInstruction = {
            role: 'system' as const,
            content: `🎯 POST-LEAD-CAPTURE INSTRUCTION (CRITICAL):
- You just collected all required contact information from the customer
- The customer originally asked: "${originalQuestion}"
- NOW YOU MUST:
  1. Briefly acknowledge their contact info (e.g., "Thanks for sharing your details!")
  2. IMMEDIATELY answer their original question: "${originalQuestion}"
  3. Use the appropriate tools (get_faqs, get_products) to find the answer
  4. Be helpful - they waited to provide their info, now give them valuable information
  
- DO NOT just say "I've processed your request" - this is WRONG
- DO NOT ask "How can I help?" - they ALREADY asked a question
- DO answer their original question completely and helpfully`
          };
          
          // Rebuild the conversation with the instruction
          const updatedHistory = [...history, postLeadInstruction];
          
          // Get a new response that actually answers the question
          const finalResponse = await llamaService.generateToolAwareResponse(
            originalQuestion, // Use the original question as the "new" message
            relevantTools,
            updatedHistory,
            systemContext,
            context.personality || 'friendly',
            context.openaiApiKey || undefined,
            context.businessAccountId,
            hasProducts,
            context.responseLength || 'balanced'
          );
          
          // If the new response has tool calls, handle them
          if (finalResponse.tool_calls && finalResponse.tool_calls.length > 0) {
            const result = await this.handleToolCalls(finalResponse, context, originalQuestion, relevantTools, appointmentsEnabled, true, systemContext);
            
            // Fetch fresh lead data after lead capture
            const freshLeadForPostLead = await storage.getLeadByConversation(conversationId, context.businessAccountId);
            
            // DEFLECTION GATE: Check if response is a deflection and route to fallback template
            let responseToStore = result.response;
            if (this.isDeflectionResponse(result.response) || result.response.includes('[[FALLBACK]]')) {
              console.log('[Deflection Gate] Post-lead handleToolCalls returned deflection, routing to fallback template');
              const fallbackInstructions = this.fallbackInstructionsCache.get(context.businessAccountId);
              
              let fallbackTemplate = fallbackInstructions && fallbackInstructions.length > 0
                ? fallbackInstructions[0]
                : "I'll need to check with our team for the specific details. Could you please share your contact information so they can reach out to you?";
              
              fallbackTemplate = this.processFallbackPlaceholders(fallbackTemplate, freshLeadForPostLead);
              const rephrased = await this.rephraseFallbackMessage(
                fallbackTemplate,
                originalQuestion,
                context.businessAccountId,
                context.openaiApiKey || undefined,
                freshLeadForPostLead
              );
              responseToStore = rephrased;
            }
            
            conversationMemory.storeMessage(context.userId, 'assistant', responseToStore);
            await this.storeMessageInDB(conversationId, 'assistant', responseToStore);
            return responseToStore;
          }
          
          // Store and return the final response
          const finalContent = finalResponse.content || 'Thank you! How can I assist you further?';
          conversationMemory.storeMessage(context.userId, 'assistant', finalContent);
          await this.storeMessageInDB(conversationId, 'assistant', finalContent);
          
          return finalContent;
        }
      }

      // Simple conversational response (no lead completion)
      let responseContent = aiResponse.content || 'I apologize, but I could not generate a response.';
      
      // FALLBACK INSTRUCTION HANDLING: If AI deflects, use user-defined fallback template DIRECTLY
      if (this.isDeflectionResponse(responseContent)) {
        const fallbackInstructions = this.fallbackInstructionsCache.get(context.businessAccountId);
        if (fallbackInstructions && fallbackInstructions.length > 0) {
          console.log('[Fallback Instruction] Using fallback template with AI rephrasing');
          
          let fallbackTemplate = fallbackInstructions[0];
          fallbackTemplate = this.processFallbackPlaceholders(fallbackTemplate, existingLead);
          
          responseContent = await this.rephraseFallbackMessage(
            fallbackTemplate, 
            userMessage, 
            context.businessAccountId,
            context.openaiApiKey || undefined,
            existingLead
          );
          console.log('[Fallback Instruction] Rephrased template applied:', responseContent.substring(0, 100) + '...');
        } else {
          responseContent = this.stripFallbackMarker(responseContent);
          console.log('[Fallback] No template configured, using stripped AI response');
        }
      }
      
      // SAFETY: Always strip [[FALLBACK]] marker before returning (in case it leaked through)
      responseContent = this.stripFallbackMarker(responseContent);
      
      conversationMemory.storeMessage(context.userId, 'assistant', responseContent);
      await this.storeMessageInDB(conversationId, 'assistant', responseContent);
      
      // Monitor post-resolution feedback (if customer responds after AI auto-resolved ticket)
      await feedbackMonitoringService.monitorPostResolutionFeedback(
        context.businessAccountId,
        conversationId,
        userMessage
      );

      // Check if we should auto-escalate to support ticket (async, non-blocking)
      this.checkAutoEscalationAsync(conversationId, context.businessAccountId, userMessage, responseContent);
      
      // Auto-detect low-confidence responses for Question Bank
      await this.detectAndLogUnansweredQuestion(
        conversationId,
        context.businessAccountId,
        userMessage,
        responseContent
      );
      
      // Auto-categorize conversation after sufficient activity (async, non-blocking)
      this.autoCategorizeConversationAsync(conversationId, context.businessAccountId, context.openaiApiKey);
      this.autoSummarizeConversationAsync(conversationId, context.businessAccountId, context.openaiApiKey);
      
      return responseContent;
    } catch (error: any) {
      console.error('Chat service error:', error);
      return "I'm having trouble processing your request right now. Please try again.";
    }
  }

  private async detectAndLogUnansweredQuestion(
    conversationId: string,
    businessAccountId: string,
    userQuestion: string,
    aiResponse: string
  ): Promise<void> {
    try {
      // Check if Question Bank is enabled for this business account
      const businessAccount = await storage.getBusinessAccount(businessAccountId);
      if (businessAccount?.questionBankEnabled !== 'true') {
        return;
      }

      // Patterns that indicate the AI couldn't answer properly
      const lowConfidencePatterns = [
        /i don't (know|have|understand)/i,
        /i('m| am) (not sure|unable|sorry)/i,
        /i (can't|cannot) (help|assist|answer)/i,
        /i don't have (that|this|enough) information/i,
        /please (contact|reach out|get in touch)/i,
        /i apologize.*(couldn't|can't|cannot)/i,
        /unfortunately.*(don't|can't|cannot)/i,
        /i'm having trouble/i,
        /i don't appear to have/i,
        /not able to (find|locate|help)/i
      ];

      // Check if the response matches any low-confidence pattern
      const isLowConfidence = lowConfidencePatterns.some(pattern => pattern.test(aiResponse));
      
      if (!isLowConfidence) {
        return;
      }

      // Calculate a simple confidence score (0-1) based on response patterns
      let confidenceScore = 0.3; // Default low confidence
      if (aiResponse.length < 50) confidenceScore = 0.2; // Very short response
      if (aiResponse.includes("I apologize")) confidenceScore = 0.25;
      if (aiResponse.includes("I'm not sure")) confidenceScore = 0.15;
      if (aiResponse.includes("I don't know")) confidenceScore = 0.1;

      // Try to categorize the question based on keywords
      let category = 'general';
      if (/price|cost|payment|fee/i.test(userQuestion)) category = 'pricing';
      else if (/product|item|sell|buy/i.test(userQuestion)) category = 'product';
      else if (/shipping|deliver|ship/i.test(userQuestion)) category = 'shipping';
      else if (/return|refund|exchange/i.test(userQuestion)) category = 'returns';
      else if (/support|help|problem|issue/i.test(userQuestion)) category = 'support';
      else if (/account|login|password/i.test(userQuestion)) category = 'account';

      // Create Question Bank entry
      await storage.createQuestionBankEntry({
        businessAccountId,
        conversationId,
        messageId: null,
        question: userQuestion,
        aiResponse,
        userContext: null,
        status: 'new',
        category,
        confidenceScore: confidenceScore.toString()
      });

      console.log('[Question Bank] Auto-logged low-confidence response:', {
        question: userQuestion.substring(0, 50),
        category,
        confidenceScore
      });
    } catch (error) {
      console.error('[Question Bank] Error auto-logging question:', error);
    }
  }

  private async handleToolCalls(
    aiResponse: any,
    context: ChatContext,
    userMessage: string,
    relevantTools: any[],
    appointmentsEnabled: boolean,
    skipDBStore: boolean = false,
    systemContext?: string
  ): Promise<{ response: string; products?: any[]; pagination?: any; searchQuery?: string; appointmentSlots?: { slots: Record<string, string[]>; durationMinutes: number }; nextFormStep?: { stepId: string; questionText: string; questionType: string; isRequired: boolean; options?: string[]; placeholder?: string }; jobs?: any[]; applicantId?: string }> {
    // Get conversationId first so we can pass it to tools
    const conversationId = await this.getOrCreateConversation(context);
    
    // Rebuild conversation history to include the latest user message
    const updatedHistory = conversationMemory.getConversationHistory(context.userId);
    
    const messages: any[] = [
      ...updatedHistory,
      { role: 'assistant' as const, content: aiResponse.content || '', tool_calls: aiResponse.tool_calls }
    ];

    // Track products if get_products tool is called
    let products: any[] | undefined;
    let pagination: any | undefined;
    let searchQuery: string | undefined;
    
    // Track appointment slots if get_appointments tool is called
    let appointmentSlots: { slots: Record<string, string[]>; durationMinutes: number } | undefined;

    let jobs: any[] | undefined;
    let applicantId: string | undefined;

    // Execute all tool calls
    for (const toolCall of aiResponse.tool_calls) {
      const toolName = toolCall.function.name;
      const toolParams = JSON.parse(toolCall.function.arguments);

      if (toolName === 'parse_resume_and_match') {
        if (context.resumeText) {
          toolParams.resumeText = context.resumeText;
          toolParams.conversationId = conversationId;
          if (context.resumeUrl) toolParams.resumeUrl = context.resumeUrl;
          console.log(`[Chat] Overriding parse_resume_and_match params with actual resume text (${context.resumeText.length} chars)${context.resumeUrl ? ' + PDF URL' : ''}`);
        } else {
          console.warn(`[Chat] parse_resume_and_match called but no context.resumeText available — blocking tool call`);
          const errorResult = { success: false, message: 'No resume was uploaded yet. Please upload your resume PDF first so I can match you with relevant jobs.' };
          messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(errorResult) });
          continue;
        }
      }

      const result = await ToolExecutionService.executeTool(
        toolName,
        toolParams,
        {
          businessAccountId: context.businessAccountId,
          userId: context.userId,
          conversationId: conversationId,
          visitorCity: context.visitorCity,
          userMessage: userMessage,
          selectedLanguage: context.preferredLanguage
        },
        userMessage,
        appointmentsEnabled
      );

      // Capture products if this was a get_products call (including pagination for "Show More")
      if (toolName === 'get_products' && result.success && 'data' in result && Array.isArray(result.data)) {
        products = result.data;
        // Capture pagination info for "Show More" functionality
        if ('pagination' in result) {
          pagination = result.pagination;
          // Get the original search query from the tool params
          searchQuery = toolParams.search || userMessage;
        }
      }
      
      if ((toolName === 'search_jobs' || toolName === 'parse_resume_and_match') && result.success && 'data' in result && Array.isArray(result.data) && result.data.length > 0) {
        if (!jobs) jobs = result.data;
        if (result.applicant) {
          applicantId = result.applicant.id;
        }
      }

      // Capture appointment slots if this was a get_appointments call
      if (toolName === 'get_appointments' && result.success && 'data' in result && result.data) {
        const data = result.data as { slots?: Record<string, string[]>; duration_minutes?: number };
        if (data.slots && Object.keys(data.slots).length > 0) {
          appointmentSlots = {
            slots: data.slots,
            durationMinutes: data.duration_minutes || 30
          };
          console.log('[Appointments] Captured slots for calendar UI:', Object.keys(data.slots).length, 'days');
        }
      }

      // RELEVANCE GATE: Check all FAQ/product candidates and keep first relevant one
      // If none are relevant, indicate no matches found to trigger fallback
      // Strip imageUrl from product data sent to AI — AI has no use for image URLs and may embed them as markdown
      let resultForAI = (toolName === 'get_products' && result.success && 'data' in result && Array.isArray(result.data))
        ? { ...result, data: result.data.map(({ imageUrl, ...rest }: any) => rest) }
        : result;
      if (toolName === 'get_products' && result.success && 'data' in result && Array.isArray(result.data) && result.data.length > 0) {
        resultForAI = {
          ...resultForAI,
          _ui_note: `IMPORTANT: Product cards are automatically displayed to the user in the chat UI. Do NOT list product names, prices, or details in your text response. Just write a brief, natural intro sentence (e.g. "Here are some great options for you!") and optionally ask a follow-up question. Never use bullet points or numbered lists for product names.`
        };
      }
      if ((toolName === 'search_jobs' || toolName === 'parse_resume_and_match') && result.success && 'data' in result && Array.isArray(result.data) && result.data.length > 0) {
        resultForAI = {
          ...resultForAI,
          _ui_note: `CRITICAL INSTRUCTION — FOLLOW EXACTLY: Job cards with full details (title, salary, location, skills, match score, Apply button) are ALREADY rendered as visual cards in the chat UI below your message. You MUST NOT list any job titles, locations, salaries, departments, or details in your text — not as bullet points, numbered lists, or inline mentions. Your ENTIRE response must be ONE short paragraph (2-3 sentences max), e.g. "Great news! I found some positions that match your profile. You can browse the cards below and click Apply Now on any role you like!" NEVER list specific job names.`
        };
      }
      let toolResultContent = JSON.stringify(resultForAI);
      
      if (result.success && 'data' in result && Array.isArray(result.data) && result.data.length > 0) {
        if (toolName === 'get_faqs') {
          // Find the first FAQ that passes relevance check
          let relevantFaq = null;
          let bestRelevanceInfo = { score: 0, reason: '' };
          
          for (const faq of result.data) {
            const relevanceCheck = this.checkRelevance(
              userMessage,
              { question: faq.question, answer: faq.answer },
              'faq'
            );
            
            if (relevanceCheck.isRelevant) {
              relevantFaq = faq;
              console.log(`[Relevance Gate] FAQ PASSED in handleToolCalls (${relevanceCheck.score}%): ${relevanceCheck.reason}`);
              break; // Use first relevant FAQ
            } else if (relevanceCheck.score > bestRelevanceInfo.score) {
              bestRelevanceInfo = { score: relevanceCheck.score, reason: relevanceCheck.reason };
            }
          }
          
          if (!relevantFaq) {
            console.log(`[Relevance Gate] All ${result.data.length} FAQs FAILED in handleToolCalls (best: ${bestRelevanceInfo.score}%): ${bestRelevanceInfo.reason}`);
            // No relevant FAQs - indicate to AI that no matches were found
            toolResultContent = JSON.stringify({
              success: true,
              data: [],
              message: 'No FAQs found that match the user\'s specific question. You should use your fallback response.'
            });
          } else {
            // Use only the relevant FAQ
            toolResultContent = JSON.stringify({
              success: true,
              data: [relevantFaq]
            });
          }
        } else if (toolName === 'get_products') {
          // Find the first product that passes relevance check
          let relevantProducts: any[] = [];
          let checkedCount = 0;
          
          for (const product of result.data) {
            const relevanceCheck = this.checkRelevance(
              userMessage,
              { name: product.name, description: product.description },
              'product'
            );
            
            if (relevanceCheck.isRelevant) {
              relevantProducts.push(product);
              if (relevantProducts.length === 1) {
                console.log(`[Relevance Gate] Product PASSED in handleToolCalls (${relevanceCheck.score}%): ${relevanceCheck.reason}`);
              }
            }
            checkedCount++;
            if (relevantProducts.length >= 5) break; // Limit to 5 relevant products
          }
          
          if (relevantProducts.length === 0) {
            console.log(`[Relevance Gate] All ${checkedCount} products FAILED in handleToolCalls`);
            // No relevant products - indicate to AI that no matches were found
            toolResultContent = JSON.stringify({
              success: true,
              data: [],
              message: 'No products found that match the user\'s specific query.'
            });
            products = undefined; // Don't show irrelevant products
          } else {
            console.log(`[Relevance Gate] Found ${relevantProducts.length} relevant products out of ${checkedCount} checked`);
            toolResultContent = JSON.stringify({
              success: true,
              data: relevantProducts
            });
            products = relevantProducts; // Only show relevant products
          }
        }
      }

      // Add tool result to messages
      messages.push({
        role: 'tool' as const,
        tool_call_id: toolCall.id,
        content: toolResultContent
      });

      // DETERMINISTIC LEAD COMPLETION DETECTION: Check if all required fields were just collected
      // When this flag is present, inject a reminder to answer the original question
      if (result.success && 'data' in result && result.data && typeof result.data === 'object' && 'allRequiredFieldsCollected' in result.data && result.data.allRequiredFieldsCollected === true) {
        console.log('[Lead Completion] All required fields collected - injecting reminder to answer original question');
        
        // Inject system message AFTER tool results but BEFORE AI continues
        // This ensures AI remembers to answer the user's original question
        messages.push({
          role: 'system' as const,
          content: `🎯 IMPORTANT REMINDER: You just finished collecting ALL required contact information from the customer. Now, IMMEDIATELY answer their original question that they asked at the start of this conversation. Do NOT ask "How can I help you?" or "Would you like to know about [topic]?" - they ALREADY asked a question. Review the conversation history to find their initial query and answer it directly in your next response. Example: "Thank you! Now, about [their original question]..." and then provide the complete answer.`
        });
      }
    }

    // Include system context so continueToolConversation has proper persona/instructions
    const messagesForContinuation = systemContext
      ? [{ role: 'system' as const, content: systemContext }, ...messages]
      : messages;

    // When K12 tools already returned data, don't pass tools to the continuation
    // call — prevents AI from calling another tool instead of answering
    const executedToolNames = aiResponse.tool_calls.map((tc: any) => tc.function.name);
    const hasK12ToolResult = executedToolNames.some((n: string) => n === 'fetch_k12_topic' || n === 'fetch_k12_questions');
    const continuationTools = hasK12ToolResult ? [] : relevantTools;

    // Get final response from AI with tool results (using same relevant tools)
    const finalResponse = await llamaService.continueToolConversation(
      messagesForContinuation,
      continuationTools,
      context.personality || 'friendly',
      context.openaiApiKey || undefined,
      context.businessAccountId,
      context.preferredLanguage,
      context.responseLength || 'balanced'
    );

    const responseContent = finalResponse.content || 'I processed your request.';
    conversationMemory.storeMessage(context.userId, 'assistant', responseContent);
    
    // Only store to DB if not in a secondary/nested context (post-lead, post-refusal processing)
    // Those flows will store the final processed response themselves
    if (!skipDBStore) {
      await this.storeMessageInDB(conversationId, 'assistant', responseContent);
    }
    
    // Monitor post-resolution feedback (if customer responds after AI auto-resolved ticket)
    await feedbackMonitoringService.monitorPostResolutionFeedback(
      context.businessAccountId,
      conversationId,
      userMessage
    );
    
    // Check if we should auto-escalate to support ticket (async, non-blocking)
    this.checkAutoEscalationAsync(conversationId, context.businessAccountId, userMessage, responseContent);
    
    // Always return object format for consistency
    return { 
      response: responseContent, 
      products: products && products.length > 0 ? products : undefined,
      pagination: pagination,
      searchQuery: searchQuery,
      appointmentSlots: appointmentSlots,
      jobs: jobs && jobs.length > 0 ? jobs : undefined,
      applicantId: applicantId,
    };
  }

  /**
   * Check if conversation should be auto-escalated to a support ticket
   * Runs async (non-blocking) with debouncing to avoid repeated expensive checks
   */
  private checkAutoEscalationAsync(
    conversationId: string,
    businessAccountId: string,
    customerMessage: string,
    aiResponse: string
  ): void {
    // Check if we've already escalated checked recently for this conversation
    const lastCheck = this.lastEscalationCheck.get(conversationId) || 0;
    const now = Date.now();
    
    if (now - lastCheck < this.ESCALATION_CHECK_DEBOUNCE_MS) {
      return; // Skip this check, ran too recently
    }
    
    this.lastEscalationCheck.set(conversationId, now);
    
    // Run escalation check async (non-blocking)
    (async () => {
      try {
        // Get conversation history for analysis (only get last few messages, not all)
        const messages = await storage.getMessagesByConversation(conversationId, businessAccountId);
        // Only use last 10 messages to keep analysis fast
        const recentMessages = messages.slice(-10);
        const conversationHistory = recentMessages.map(m => ({
          role: m.role === 'user' ? 'user' as const : 'assistant' as const,
          content: m.content
        }));

        // Analyze if escalation is needed
        const escalationAnalysis = await autoEscalationService.analyzeForEscalation(
          businessAccountId,
          conversationId,
          customerMessage,
          aiResponse,
          conversationHistory
        );

        // Get business account's escalation sensitivity setting
        const businessAccount = await storage.getBusinessAccount(businessAccountId);
        const escalationSensitivity = businessAccount?.escalationSensitivity || 'medium';

        // Apply escalation sensitivity to final decision
        let shouldActuallyEscalate = escalationAnalysis.shouldEscalate;
        
        if (escalationSensitivity === 'low') {
          shouldActuallyEscalate = escalationAnalysis.shouldEscalate && escalationAnalysis.confidence >= 0.8;
          if (escalationAnalysis.shouldEscalate && !shouldActuallyEscalate) {
            console.log(`[Chat] Escalation skipped due to low sensitivity (confidence ${escalationAnalysis.confidence} < 0.8)`);
          }
        } else if (escalationSensitivity === 'high') {
          shouldActuallyEscalate = escalationAnalysis.shouldEscalate || 
            (escalationAnalysis.confidence >= 0.5 && (escalationAnalysis.priority === 'high' || escalationAnalysis.priority === 'urgent'));
          if (!escalationAnalysis.shouldEscalate && shouldActuallyEscalate) {
            console.log(`[Chat] Escalation triggered by high sensitivity (confidence ${escalationAnalysis.confidence}, priority ${escalationAnalysis.priority})`);
          }
        }

        if (shouldActuallyEscalate) {
          console.log('[Chat] Auto-escalating conversation to support ticket. Reason:', escalationAnalysis.reason);
          
          const ticketId = await autoEscalationService.autoEscalateToTicket(
            businessAccountId,
            conversationId,
            escalationAnalysis
          );

          if (ticketId) {
            console.log('[Chat] Support ticket created and auto-resolved (if high confidence):', ticketId);
          }
        }
      } catch (error) {
        console.error('[Chat] Error in auto-escalation check:', error);
      }
    })();
  }

  /**
   * Auto-categorize conversation after it has sufficient activity
   * Runs async (non-blocking) and only categorizes if not already categorized
   * and conversation has at least 2 user messages
   */
  private autoCategorizeConversationAsync(
    conversationId: string,
    businessAccountId: string,
    openaiApiKey?: string | null
  ): void {
    // Run categorization async (non-blocking)
    (async () => {
      try {
        // Check if conversation is already categorized
        const conversation = await storage.getConversation(conversationId, businessAccountId);
        if (conversation?.category) {
          return; // Already categorized
        }

        // Count user messages to ensure sufficient activity
        const messages = await storage.getMessagesByConversation(conversationId, businessAccountId);
        const userMessageCount = messages.filter(m => m.role === 'user').length;
        
        // Only categorize if at least 1 user message exists
        if (userMessageCount < 1) {
          return;
        }

        console.log(`[AutoCategorize] Categorizing conversation ${conversationId} with ${userMessageCount} user messages`);
        
        const success = await categorizeAndSaveConversation(conversationId, businessAccountId, openaiApiKey || undefined);
        
        if (success) {
          console.log(`[AutoCategorize] Successfully categorized conversation ${conversationId}`);
        }
      } catch (error) {
        console.error('[AutoCategorize] Error:', error);
      }
    })();
  }

  private autoSummarizeConversationAsync(
    conversationId: string,
    businessAccountId: string,
    openaiApiKey?: string | null
  ): void {
    (async () => {
      try {
        const msgs = await storage.getMessagesByConversation(conversationId, businessAccountId);
        if (msgs.length < 3) return;

        const conversation = await storage.getConversation(conversationId, businessAccountId);
        if (conversation?.summary && msgs.length < 6) return;
        if (conversation?.summary && msgs.length % 3 !== 0) return;

        console.log(`[AutoSummarize] Summarizing conversation ${conversationId} with ${msgs.length} messages`);
        const success = await summarizeAndSaveConversation(conversationId, openaiApiKey || undefined);
        if (success) {
          console.log(`[AutoSummarize] Successfully summarized conversation ${conversationId}`);
        }
      } catch (error) {
        console.error('[AutoSummarize] Error:', error);
      }
    })();
  }

  async *streamMessage(userMessage: string, context: ChatContext) {
    try {
      // Get conversation history to check if this is a new conversation
      const existingHistory = conversationMemory.getConversationHistory(context.userId);
      const isFirstMessage = existingHistory.length === 0;
      
      // SPAM DETECTION: Check first message - if spam, use simplified path (no DB, no journeys, just AI response)
      // Skip spam check for resume uploads — they must go through the full AI flow
      if (isFirstMessage && context.openaiApiKey && !userMessage.startsWith('[RESUME_UPLOAD]') && !userMessage.startsWith('[JOB_APPLY]') && !context.resumeText) {
        const spamCheck = await isGibberishAI(userMessage, context.openaiApiKey);
        if (spamCheck.isSpam && spamCheck.confidence === 'high') {
          console.log('[Chat] Spam detected - using simplified response path:', userMessage.substring(0, 50));
          
          // Yield temp conversation ID
          yield { type: 'conversation_id' as const, data: `temp_${context.userId}_${Date.now()}` };
          
          // Store in memory only (no DB)
          conversationMemory.storeMessage(context.userId, 'user', userMessage);
          
          // Call AI directly with minimal context - let it respond naturally
          const response = await this.getSimpleAIResponse(userMessage, context);
          conversationMemory.storeMessage(context.userId, 'assistant', response);
          
          // Stream the response
          yield { type: 'content' as const, data: response };
          yield { type: 'final' as const, data: response };
          yield { type: 'done' as const, data: '' };
          return;
        }
      }
      
      // Get or create conversation (normal flow)
      const conversationId = await this.getOrCreateConversation(context);
      
      // Yield conversationId first so client can store it for persistence
      yield { type: 'conversation_id' as const, data: conversationId };
      
      // Get conversation history to check if AI recently asked for name
      const history = conversationMemory.getConversationHistory(context.userId);
      const lastAIMessage = history.length > 0 && history[history.length - 1].role === 'assistant' 
        ? history[history.length - 1].content 
        : undefined;
      
      // Auto-detect and capture contact information from user message
      // Skip for very short messages (likely not containing contact info)
      // Skip lead capture entirely for guidance chatbot
      if (userMessage.length > 2 && !context.skipLeadTraining) {
        // Run async to avoid blocking response
        this.autoDetectAndCaptureLead(userMessage, conversationId, context.businessAccountId, lastAIMessage, context.visitorCity, context.visitorSessionId, context.pageUrl).catch(err => {
          console.error('[Chat] Error in auto lead capture:', err);
        });
      }
      
      // Generate and update conversation title from first user message (async, non-blocking)
      if (context.openaiApiKey) {
        this.maybeUpdateConversationTitle(conversationId, context.businessAccountId, userMessage, context.openaiApiKey).catch(err => {
          console.error('[Chat] Error updating conversation title:', err);
        });
      }
      
      // PERFORMANCE: Early check if business has any active journeys
      // Skip all journey processing if no journeys exist for this account
      const hasActiveJourneys = await journeyService.hasActiveJourneys(context.businessAccountId);
      let isJourneyActive = false;
      
      if (hasActiveJourneys) {
        // Auto-inject journey conversational guidelines if not already provided and if journey is active
        if (!context.journeyConversationalGuidelines) {
          const activeJourneyState = await journeyService.getJourneyState(conversationId);
          if (activeJourneyState && !activeJourneyState.completed) {
            const journey = await storage.getJourney(activeJourneyState.journeyId, context.businessAccountId);
            if (journey && journey.conversationalGuidelines) {
              // Parse journey instructions from JSON array and format as string
              try {
                const instructions = JSON.parse(journey.conversationalGuidelines);
                if (Array.isArray(instructions) && instructions.length > 0) {
                  context.journeyConversationalGuidelines = instructions
                    .map((inst: any, index: number) => `${index + 1}. ${inst.text}`)
                    .join('\n');
                }
              } catch {
                // Legacy format - use as-is if not JSON
                context.journeyConversationalGuidelines = journey.conversationalGuidelines;
              }
            }
          }
        }
      }
      
      // Store user message in memory and database
      conversationMemory.storeMessage(context.userId, 'user', userMessage);
      await this.storeMessageInDB(conversationId, 'user', userMessage);

      if (userMessage.startsWith('[JOB_APPLY]')) {
        const applyMatch = userMessage.match(/\|jobId:([^|]+)\|applicantId:([^|]+)/);
        const clientJobTitle = userMessage.replace(/^\[JOB_APPLY\]\s*/, '').replace(/\s*\|jobId:.*$/, '').trim();
        if (applyMatch) {
          const jobId = applyMatch[1].trim();
          const applicantId = applyMatch[2].trim();
          console.log(`[Chat Stream] JOB_APPLY intercept: jobId=${jobId}, applicantId=${applicantId}, title="${clientJobTitle}"`);
          try {
            const result = await ToolExecutionService.executeTool(
              'apply_to_job',
              { jobId, applicantId },
              {
                businessAccountId: context.businessAccountId,
                userId: context.userId,
                conversationId: conversationId,
                visitorCity: context.visitorCity,
                userMessage: userMessage,
                selectedLanguage: context.preferredLanguage
              },
              userMessage,
              false
            );
            const resultData = result.success && 'data' in result && result.data ? result.data : {};
            const serverTitle = resultData.jobTitle || clientJobTitle;
            const reply = result.success
              ? `Your application for **${serverTitle}** has been submitted successfully! The hiring team will review your profile and get back to you soon.`
              : `Sorry, I couldn't submit your application. ${result.message || 'Please try again.'}`;
            conversationMemory.storeMessage(context.userId, 'assistant', reply);
            await this.storeMessageInDB(conversationId, 'assistant', reply);
            yield { type: 'content' as const, data: reply };
            yield { type: 'final' as const, data: reply };
            yield { type: 'done' as const, data: '' };
            return;
          } catch (err) {
            console.error('[Chat Stream] JOB_APPLY error:', err);
            const errReply = `Sorry, something went wrong while submitting your application. Please try again.`;
            conversationMemory.storeMessage(context.userId, 'assistant', errReply);
            await this.storeMessageInDB(conversationId, 'assistant', errReply);
            yield { type: 'content' as const, data: errReply };
            yield { type: 'final' as const, data: errReply };
            yield { type: 'done' as const, data: '' };
            return;
          }
        } else {
          const errReply = 'Sorry, the application request was malformed. Please try clicking Apply Now again.';
          conversationMemory.storeMessage(context.userId, 'assistant', errReply);
          await this.storeMessageInDB(conversationId, 'assistant', errReply);
          yield { type: 'content' as const, data: errReply };
          yield { type: 'final' as const, data: errReply };
          yield { type: 'done' as const, data: '' };
          return;
        }
      }

      try {
        const { getSmartReplyResponse } = await import('./services/smartReplyService');
        const smartReply = await getSmartReplyResponse(context.businessAccountId, "website", userMessage);
        if (smartReply) {
          console.log(`[Chat Stream] Smart reply matched: "${smartReply.matchedKeyword}" — returning configured response directly (skipping AI)`);
          conversationMemory.storeMessage(context.userId, 'assistant', smartReply.text);
          await this.storeMessageInDB(conversationId, 'assistant', smartReply.text);
          yield { type: 'content' as const, data: smartReply.text };
          yield { type: 'final' as const, data: smartReply.text };
          yield { type: 'done' as const, data: '' };
          return;
        }
      } catch (err) {
        console.error("[Chat Stream] Smart reply error (non-fatal):", err);
      }

      // Only process journeys if business has active journeys configured
      if (hasActiveJourneys) {
        // ENGINE-DRIVEN MODE: Try processing through journey engine first
        const engineResult = await journeyOrchestrator.processUserMessageEngineDriven(
          conversationId,
          context.userId,
          context.businessAccountId,
          userMessage
        );

        // If engine handled the message, stream engine's response
        if (engineResult.shouldBypassAI && engineResult.response) {
          console.log('[Chat] Engine-driven journey handled message - bypassing AI (streaming)');
          
          // For form journeys, emit form_step SSE event for visual UI
          if (engineResult.formStep) {
            console.log('[Chat Stream] Engine returned form step - emitting form_step:', engineResult.formStep.questionText?.substring(0, 30));
            // Include conversationId so client can track which conversation to use for form step submission
            // Include isComplete flag so widget knows when to disable chat input after journey ends
            yield { type: 'form_step' as const, data: JSON.stringify({ ...engineResult.formStep, conversationId, journeyComplete: engineResult.isComplete }) };
          }
          
          // Store engine's response
          conversationMemory.storeMessage(context.userId, 'assistant', engineResult.response);
          await this.storeMessageInDB(conversationId, 'assistant', engineResult.response);
          
          // Stream the response word-by-word for natural typing effect
          const words = engineResult.response.split(' ');
          for (let i = 0; i < words.length; i++) {
            const word = words[i];
            const chunk = i === words.length - 1 ? word : word + ' ';
            yield { type: 'content' as const, data: chunk };
          }
          
          yield { type: 'final' as const, data: engineResult.response };
          yield { type: 'done' as const, data: '' };
          return;
        }

        // Fall back to AI-guided journey (if enabled) or normal chat
        const journeyResult = await journeyOrchestrator.processUserMessage(
          conversationId,
          context.userId,
          context.businessAccountId,
          userMessage
        );
        isJourneyActive = journeyResult.isJourneyActive;
        
        // For form journeys triggered by keyword, emit form_step SSE event for visual UI
        // Return early to prevent AI from asking the same question as text
        if (journeyResult.formStep) {
          console.log('[Chat Stream] Form journey triggered by keyword - emitting form_step:', journeyResult.formStep.questionText?.substring(0, 30));
          // Include conversationId so client can track which conversation to use for form step submission
          yield { type: 'form_step' as const, data: JSON.stringify({ ...journeyResult.formStep, conversationId }) };
          
          // Store a brief acknowledgment as AI response (not the question itself)
          const acknowledgment = "Great! Let me help you with that. Please select from the options below:";
          conversationMemory.storeMessage(context.userId, 'assistant', acknowledgment);
          await this.storeMessageInDB(conversationId, 'assistant', acknowledgment);
          
          // Stream the acknowledgment and return - form UI handles the question
          yield { type: 'content' as const, data: acknowledgment };
          yield { type: 'final' as const, data: acknowledgment };
          yield { type: 'done' as const, data: '' };
          return;
        }
      } else {
        console.log('[Chat] No active journeys for business - skipping journey processing (stream)');
      }
      
      let fullResponse = '';
      let hasToolCalls = false;
      const toolCalls: any[] = [];
      let bufferedContent: string[] = []; // Buffer content to conditionally stream

      // Build enriched system context with company info and all FAQs
      // This includes PDF summaries and key points - should answer most questions
      let systemContext = await this.buildEnrichedContext(context);

      // SMART TIMING: Count user messages for lead gate activation
      // Note: history was captured BEFORE the current message was stored, so add 1
      const userMessageCount = history.filter(m => m.role === 'user').length + 1;
      const isFirstUserMessage = userMessageCount <= 1;
      
      // DEBUG: Log the message count for troubleshooting
      console.log(`[Smart Timing] History length: ${history.length}, User messages in history: ${history.filter(m => m.role === 'user').length}, Total count (incl current): ${userMessageCount}, isFirst: ${isFirstUserMessage}`);
      
      // CRITICAL: Inject dynamic message count status at the BEGINNING of context
      // LLMs pay more attention to content at the start - this ensures the lead gate is noticed
      let smartTimingPrefix = '';
      if (isFirstUserMessage) {
        smartTimingPrefix = `🟢 CONVERSATION STATUS: This is the user's FIRST message (message #1). Answer freely - no lead collection required yet.\n\n`;
      } else {
        smartTimingPrefix = `🔴 URGENT - LEAD GATE ACTIVE 🔴\n`;
        smartTimingPrefix += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        smartTimingPrefix += `This is user message #${userMessageCount}. YOU MUST ASK FOR THEIR NAME FIRST!\n`;
        smartTimingPrefix += `\n`;
        smartTimingPrefix += `⛔ DO NOT answer their question yet!\n`;
        smartTimingPrefix += `⛔ STOP and ask: "I'd love to help! May I know your name first?"\n`;
        smartTimingPrefix += `⛔ Only answer AFTER they provide their name.\n`;
        smartTimingPrefix += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
      }
      
      // PREPEND the status to systemContext (not append) so it's at the top
      systemContext = smartTimingPrefix + systemContext;
      
      console.log(`[Smart Timing] Injected status at START: isFirst=${isFirstUserMessage}, count=${userMessageCount}`);

      // HANDOFF-AWARE GUARDRAIL: Detect if conversation is in "handoff complete" state
      // If the last assistant message was a handoff confirmation and user sends simple acknowledgement,
      // instruct AI to respond conversationally WITHOUT calling any tools
      const lastAssistantMessage = history.filter(m => m.role === 'assistant').slice(-1)[0]?.content || '';
      const isHandoffComplete = this.isHandoffConfirmationMessage(lastAssistantMessage);
      const isAcknowledgement = this.isSimpleAcknowledgement(userMessage);
      
      // Track if we should skip tools entirely for this request
      let skipToolsForHandoff = false;
      
      if (isHandoffComplete && isAcknowledgement) {
        console.log(`[Handoff Guardrail] Detected acknowledgement after handoff - DISABLING tools`);
        skipToolsForHandoff = true;
        const handoffGuardrail = `
🛑 HANDOFF COMPLETE - CONVERSATION MODE 🛑
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
The previous question has been RESOLVED - you already confirmed our team will reach out.
The user just said "${userMessage}" - this is a simple acknowledgement, NOT a new question.

Simply acknowledge their response warmly and briefly.
Example: "Great! Is there anything else I can help you with?"
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

`;
        systemContext = handoffGuardrail + systemContext;
      } else if (isHandoffComplete) {
        console.log(`[Handoff Guardrail] Handoff complete, user asking new question: "${userMessage.substring(0, 50)}..."`);
      }

      // Run RAG search and DB fetches in parallel — they are fully independent
      // RAG embedding call (~200ms) now overlaps with DB reads (~50ms) instead of preceding them
      console.log('[RAG] Running document chunk search for query');
      const [ragContext, [businessAccount, widgetSettings, existingLead, products]] = await Promise.all([
        this.addRAGContext(userMessage, context.businessAccountId),
        Promise.all([
          storage.getBusinessAccount(context.businessAccountId),
          storage.getWidgetSettings(context.businessAccountId),
          storage.getLeadByConversation(conversationId, context.businessAccountId),
          storage.getAllProducts(context.businessAccountId)
        ])
      ]);
      systemContext += ragContext;

      if (context.resumeText) {
        systemContext += `\n\n=== RESUME UPLOADED BY VISITOR ===\nThe visitor has uploaded their resume. You MUST call the parse_resume_and_match tool to analyze it and find matching jobs.\n---RESUME_TEXT---\n${context.resumeText.substring(0, 8000)}\n=== END RESUME ===\n`;
        console.log(`[Chat Stream] Resume text injected into system context (${context.resumeText.length} chars)`);
      }

      try {
        if (existingLead && (existingLead.phone || existingLead.email)) {
          const platformUserId = context.visitorToken || conversationId;
          const profile = await resolveProfile(context.businessAccountId, {
            phone: existingLead.phone || null,
            email: existingLead.email || null,
            name: existingLead.name || null,
            city: context.visitorCity || null,
            platform: "website",
            platformUserId,
          });
          if (profile) {
            const isFirstMsg = !history.some((m: any) => m.role === 'assistant');
            const crossPlatformCtx = await composeCrossPlatformContext(context.businessAccountId, "website", profile.id, isFirstMsg);
            if (crossPlatformCtx) {
              systemContext += `\n\n${crossPlatformCtx}`;
              console.log(`[Chat-Stream] Cross-platform context injected (${crossPlatformCtx.length} chars, firstMsg: ${isFirstMsg})`);
            }
            triggerSnapshotUpdate(context.businessAccountId, profile.id, "website", platformUserId);
          }
        }
      } catch (err) {
        console.error("[Chat-Stream] Cross-platform context error (non-fatal):", err);
      }

      // Appointments are enabled only if BOTH business account AND widget settings allow it
      const appointmentsEnabled = 
        businessAccount?.appointmentsEnabled === 'true' && 
        widgetSettings?.appointmentBookingEnabled === 'true';

      // Check if business has products - only include product tool if products exist
      const hasProducts = products.length > 0;

      // AI-GUIDED JOURNEYS: Check if journey is active and include journey tools
      // This allows AI to intelligently manage journeys while staying conversational
      // HANDOFF GUARDRAIL: Pass no tools if we're in acknowledgement-after-handoff mode
      // Pass conversation history to detect ongoing appointment context
      // Pass API key for AI-based product intent classification fallback
      const relevantTools = skipToolsForHandoff 
        ? [] 
        : await selectRelevantTools(context.resumeText ? `[RESUME_UPLOAD] Please analyze my resume and find matching jobs` : userMessage, appointmentsEnabled, isJourneyActive, hasProducts, history, context.openaiApiKey || undefined, context.systemMode, context.k12EducationEnabled, context.jobPortalEnabled);
      
      if (skipToolsForHandoff) {
        console.log(`[Handoff Guardrail] Tools disabled for this request - AI will respond conversationally`);
      }

      // Extract lead training config for enforcement
      // Skip lead training entirely for guidance chatbot
      const leadTrainingConfig = context.skipLeadTraining ? null : (widgetSettings?.leadTrainingConfig as any);
      
      // PHONE VALIDATION GATE — uses shared utility
      let phoneValidationFailed = false;
      let phoneValidationContext = '';
      if (!context.skipLeadTraining && leadTrainingConfig) {
        const validationOverride = buildPhoneValidationOverride(userMessage, leadTrainingConfig);
        if (validationOverride) {
          phoneValidationFailed = true;
          phoneValidationContext = validationOverride;
        }
      }

      // Extract enabled appointment trigger rules
      const appointmentTriggerRules = widgetSettings?.appointmentSuggestRules 
        ? (widgetSettings.appointmentSuggestRules as Array<{ id: string; keywords: string[]; prompt: string; enabled: boolean }>).filter(r => r.enabled)
        : null;

      // Stream AI response (pass existing lead to avoid re-asking for captured contact info)
      // Pass raw customInstructions directly to avoid truncation during extraction
      // Pass userMessageCount for SMART timing lead gate activation
      // Phone validation: pass as last-position system message override (highest GPT attention weight)
      // instead of replacing user message, so AI has full context to respond naturally
      for await (const chunk of llamaService.streamToolAwareResponse(
        userMessage,
        relevantTools,
        history,
        systemContext,
        context.personality || 'friendly',
        context.openaiApiKey || undefined,
        leadTrainingConfig,
        existingLead,
        context.preferredLanguage,
        context.businessAccountId,
        context.customInstructions,
        userMessageCount,
        hasProducts,
        context.starterQAContext,
        appointmentTriggerRules,
        context.responseLength || 'balanced',
        phoneValidationFailed ? phoneValidationContext : undefined
      )) {
        const delta = chunk.choices[0]?.delta;
        
        // Check for tool calls
        if (delta.tool_calls) {
          hasToolCalls = true;
          for (const toolCall of delta.tool_calls) {
            if (!toolCalls[toolCall.index]) {
              toolCalls[toolCall.index] = {
                id: toolCall.id || '',
                type: 'function',
                function: { name: toolCall.function?.name || '', arguments: '' }
              };
            }
            if (toolCall.function?.arguments) {
              toolCalls[toolCall.index].function.arguments += toolCall.function.arguments;
            }
          }
        }
        
        // Buffer text content instead of streaming immediately
        if (delta.content) {
          fullResponse += delta.content;
          bufferedContent.push(delta.content);
        }
      }

      // FALLBACK INSTRUCTION HANDLING: If AI deflects, use user-defined fallback template DIRECTLY
      if (!hasToolCalls && this.isDeflectionResponse(fullResponse)) {
        const fallbackInstructions = this.fallbackInstructionsCache.get(context.businessAccountId);
        if (fallbackInstructions && fallbackInstructions.length > 0) {
          console.log('[Fallback Instruction] Using fallback template with AI rephrasing (streaming)');
          
          let fallbackTemplate = fallbackInstructions[0];
          fallbackTemplate = this.processFallbackPlaceholders(fallbackTemplate, existingLead);
          
          fullResponse = await this.rephraseFallbackMessage(
            fallbackTemplate, 
            userMessage, 
            context.businessAccountId,
            context.openaiApiKey || undefined,
            existingLead
          );
          bufferedContent = [fullResponse];
          console.log('[Fallback Instruction] Rephrased template applied:', fullResponse.substring(0, 100) + '...');
        } else {
          fullResponse = this.stripFallbackMarker(fullResponse);
          bufferedContent = [fullResponse];
          console.log('[Fallback] No template configured, using stripped AI response (streaming)');
        }
      }
      
      // SAFETY: Always strip [[FALLBACK]] marker before streaming (in case it leaked through)
      fullResponse = this.stripFallbackMarker(fullResponse);
      bufferedContent = bufferedContent.map(content => this.stripFallbackMarker(content));

      // PHONE VALIDATION SAFETY NET: If phone validation failed but AI still accepted
      // the number (e.g., "thank you for sharing"), replace response with rejection
      if (phoneValidationFailed && !hasToolCalls) {
        const lowerResponse = fullResponse.toLowerCase();
        const looksLikeAcceptance = (lowerResponse.includes('thank') && (lowerResponse.includes('number') || lowerResponse.includes('sharing') || lowerResponse.includes('phone') || lowerResponse.includes('whatsapp'))) ||
          (lowerResponse.includes('got it') && (lowerResponse.includes('number') || lowerResponse.includes('phone'))) ||
          (lowerResponse.includes('noted') && lowerResponse.includes('number')) ||
          (lowerResponse.includes('received') && lowerResponse.includes('number'));
        if (looksLikeAcceptance) {
          console.log(`[Phone Validation Safety Net] AI accepted invalid phone despite rewrite — replacing response`);
          const safeResponse = `It looks like that number might not be correct — could you please double-check and share a valid number?`;
          fullResponse = safeResponse;
          bufferedContent = [safeResponse];
        }
      }

      // If NO tool calls detected, stream the buffered content now
      let contentAlreadyYielded = false;
      if (!hasToolCalls) {
        for (const content of bufferedContent) {
          yield { type: 'content', data: content };
        }
        contentAlreadyYielded = true;
      }
      // If tool calls ARE detected, discard buffered content (don't stream the initial text)

      // Log tool calls for debugging
      console.log('[Chat Stream] User message:', userMessage);
      console.log('[Chat Stream] Tool calls detected:', hasToolCalls);
      console.log('[Chat Stream] Tool calls count:', toolCalls.length);
      if (toolCalls.length > 0) {
        toolCalls.forEach((tc: any) => {
          console.log('[Chat Stream] Tool:', tc.function.name, 'Args:', tc.function.arguments);
        });
      }

      // RECOVERY: Gemini signaled a tool call during streaming but produced empty args.
      // When the product tool was in the request, synthesize the call so search still runs.
      if (hasToolCalls && toolCalls.length === 0) {
        const productToolWasAvailable = relevantTools.some((t: any) => t.function?.name === 'get_products');
        if (productToolWasAvailable) {
          console.log('[Chat Stream] Gemini empty tool-call recovery: auto-executing get_products for:', userMessage);
          toolCalls.push({
            id: 'auto_recovery_' + Date.now(),
            type: 'function',
            function: { name: 'get_products', arguments: JSON.stringify({ query: userMessage }) }
          });
        }
      }

      // Handle tool calls if any
      if (hasToolCalls && toolCalls.length > 0) {
        yield { type: 'tool_start', data: '' };
        
        const updatedHistory = conversationMemory.getConversationHistory(context.userId);
        const messages: any[] = [
          ...updatedHistory,
          { role: 'assistant', content: fullResponse, tool_calls: toolCalls }
        ];

        // Execute tools
        let productData: any = null;
        let productPagination: any = null;
        let productSearchQuery: string | null = null;
        let faqData: any = null;
        let appointmentSlotsData: { slots: Record<string, string[]>; durationMinutes: number } | null = null;
        let captureLeadHadRealData = false;
        let jobsData: any[] | null = null;
        let jobsApplicantId: string | null = null;
        for (const toolCall of toolCalls) {
          const toolName = toolCall.function.name;
          const toolParams = JSON.parse(toolCall.function.arguments);

          if (toolName === 'parse_resume_and_match') {
            if (context.resumeText) {
              toolParams.resumeText = context.resumeText;
              toolParams.conversationId = conversationId;
              if (context.resumeUrl) toolParams.resumeUrl = context.resumeUrl;
              console.log(`[Chat Stream] Overriding parse_resume_and_match params with actual resume text (${context.resumeText.length} chars)${context.resumeUrl ? ' + PDF URL' : ''}`);
            } else {
              console.warn(`[Chat Stream] parse_resume_and_match called but no context.resumeText available — blocking tool call`);
              const errorResult = { success: false, message: 'No resume was uploaded yet. Please upload your resume PDF first so I can match you with relevant jobs.' };
              messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(errorResult) });
              continue;
            }
          }

          let phoneRejected = false;
          let phoneRejectionMessage = '';
          if (toolName === 'capture_lead' && toolParams.phone && toolParams.phone.trim().length > 0 && leadTrainingConfig?.fields) {
            const mobileField = leadTrainingConfig.fields.find((f: any) => f.id === 'mobile' && f.enabled);
            const whatsappField = leadTrainingConfig.fields.find((f: any) => f.id === 'whatsapp' && f.enabled);
            const phoneValidation = mobileField?.phoneValidation || whatsappField?.phoneValidation || '10';
            
            const phoneValidationResult = validatePhoneNumber(toolParams.phone, phoneValidation as any);
            
            if (!phoneValidationResult.isValid) {
              console.log(`[Chat Stream] capture_lead PRE-VALIDATION REJECTED: phone "${toolParams.phone}" - ${phoneValidationResult.reasonMessage}`);
              phoneRejected = true;
              phoneRejectionMessage = `INVALID PHONE NUMBER: ${phoneValidationResult.reasonMessage}. DO NOT save this number. Politely tell the user their number appears to be invalid and ask them to provide a valid phone/WhatsApp number.`;
              toolParams.phone = '';
            }
          }

          console.log('[Chat Stream] Executing tool:', toolName, 'with params:', toolParams);
          let result = await ToolExecutionService.executeTool(
            toolName,
            toolParams,
            {
              businessAccountId: context.businessAccountId,
              userId: context.userId,
              conversationId: conversationId,
              visitorCity: context.visitorCity,
              userMessage: userMessage,
              selectedLanguage: context.preferredLanguage
            },
            userMessage,
            appointmentsEnabled
          );
          console.log('[Chat Stream] Tool result:', toolName, 'returned', JSON.stringify(result).substring(0, 100));

          // Capture product data for special rendering (including pagination for "Show More")
          if (toolName === 'get_products' && result.success && 'data' in result && result.data) {
            productData = result.data;
            productPagination = result.pagination || null;
            productSearchQuery = toolParams.search || null;
          }

          if ((toolName === 'search_jobs' || toolName === 'parse_resume_and_match') && result.success && 'data' in result && Array.isArray(result.data) && result.data.length > 0) {
            jobsData = result.data;
            if (result.applicant) {
              jobsApplicantId = result.applicant.id;
            }
          }

          // Fallback: when a specific search returns empty, fetch popular products as alternatives
          if (
            toolName === 'get_products' &&
            result.success &&
            'data' in result &&
            Array.isArray(result.data) &&
            result.data.length === 0 &&
            toolParams.search
          ) {
            console.log('[Chat Stream] Product search empty — running fallback browse for alternatives');
            const fallbackResult = await ToolExecutionService.executeTool(
              'get_products',
              { limit: 4 },
              {
                businessAccountId: context.businessAccountId,
                userId: context.userId,
                conversationId: conversationId,
                visitorCity: context.visitorCity,
                userMessage: userMessage,
                selectedLanguage: context.preferredLanguage
              },
              userMessage,
              appointmentsEnabled
            );
            if (
              fallbackResult.success &&
              'data' in fallbackResult &&
              Array.isArray(fallbackResult.data) &&
              fallbackResult.data.length > 0
            ) {
              productData = fallbackResult.data;
              productPagination = ('pagination' in fallbackResult ? fallbackResult.pagination : null) || null;
              productSearchQuery = null; // fallback browse has no filter — Show More must not use the original failed search term
              result = {
                success: true,
                data: fallbackResult.data,
                ...('pagination' in fallbackResult ? { pagination: fallbackResult.pagination } : {}),
                _instruction: `No exact matches for "${toolParams.search}" were found. These are popular alternative products from our catalog. Tell the user we don't have "${toolParams.search}", but here are some popular products they might like instead. Write a short natural message in the same language as the user's latest message (default to English if unclear) — product cards will display automatically, do NOT list them in text.`
              };
              console.log('[Chat Stream] Fallback browse returned', fallbackResult.data.length, 'alternative products');
            }
          }
          
          // Capture FAQ data for fallback response generation
          if (toolName === 'get_faqs' && result.success && 'data' in result && result.data) {
            faqData = result.data;
          }
          
          // Capture appointment slots for calendar UI
          if (toolName === 'list_available_slots' && result.success && 'data' in result && result.data) {
            const data = result.data as { slots?: Record<string, string[]>; duration_minutes?: number };
            if (data.slots && Object.keys(data.slots).length > 0) {
              appointmentSlotsData = {
                slots: data.slots,
                durationMinutes: data.duration_minutes || 30
              };
              console.log('[Appointments] Captured slots for calendar UI:', Object.keys(data.slots).length, 'days');
            }
          }
          
          // Track if capture_lead was called with actual contact data
          // Use OR to preserve true if any capture_lead call had real data (handles multiple calls)
          let captureLeadOriginalQuestion: string | null = null;
          if (toolName === 'capture_lead') {
            // If phone was rejected by pre-validation, override result with rejection message
            if (phoneRejected) {
              result = { success: false, error: phoneRejectionMessage };
            }

            const hasName = toolParams.name && toolParams.name.trim().length > 0;
            const hasPhone = toolParams.phone && toolParams.phone.trim().length > 0;
            const hasEmail = toolParams.email && toolParams.email.trim().length > 0;
            const thisCallHadRealData = hasName || hasPhone || hasEmail;
            captureLeadHadRealData = captureLeadHadRealData || thisCallHadRealData;
            console.log('[Chat Stream] capture_lead called with real data:', thisCallHadRealData, '(cumulative:', captureLeadHadRealData, ') params:', toolParams);
            
            // If real data was captured, find the original question to include in the result
            if (thisCallHadRealData) {
              const currentHistory = conversationMemory.getConversationHistory(context.userId);
              captureLeadOriginalQuestion = this.extractLastSubstantiveQuestion(currentHistory, userMessage);
            }
          }

          // Strip imageUrl from product data sent to AI — the AI has no use for image URLs
          // and may embed them as markdown images in its response. Frontend productData retains imageUrl.
          if (toolName === 'get_products' && result.success && 'data' in result && Array.isArray(result.data)) {
            result = {
              ...result,
              data: result.data.map(({ imageUrl, ...rest }: any) => rest)
            };
          }

          // Tell AI not to list product names/details in text — product cards render automatically in the UI
          if (toolName === 'get_products' && result.success && 'data' in result && Array.isArray(result.data) && result.data.length > 0 && !('_instruction' in result)) {
            result = {
              ...result,
              _ui_note: `IMPORTANT: Product cards are automatically displayed to the user in the chat UI. Do NOT list product names, prices, or details in your text response. Just write a brief, natural intro sentence (e.g. "Here are some great options for you!") and optionally ask a follow-up question. Never use bullet points or numbered lists for product names.`
            };
          }

          if ((toolName === 'search_jobs' || toolName === 'parse_resume_and_match') && result.success && 'data' in result && Array.isArray(result.data) && result.data.length > 0) {
            result = {
              ...result,
              _ui_note: `CRITICAL INSTRUCTION — FOLLOW EXACTLY: Job cards with full details (title, salary, location, skills, match score, Apply button) are ALREADY rendered as visual cards in the chat UI below your message. You MUST NOT list any job titles, locations, salaries, departments, or details in your text — not as bullet points, numbered lists, or inline mentions. Your ENTIRE response must be ONE short paragraph (2-3 sentences max), e.g. "Great news! I found some positions that match your profile. You can browse the cards below and click Apply Now on any role you like!" NEVER list specific job names.`
            };
          }

          // For capture_lead with real data, enhance the result to include the original question context
          let toolResultContent = JSON.stringify(result);
          if (toolName === 'capture_lead' && captureLeadOriginalQuestion) {
            const enhancedResult = {
              ...result,
              _instruction: `Contact info saved successfully. Now briefly thank them and IMMEDIATELY answer their original question: "${captureLeadOriginalQuestion}". Do NOT just say "How can I help?" - answer their question about ${captureLeadOriginalQuestion}.`
            };
            toolResultContent = JSON.stringify(enhancedResult);
            console.log('[Chat Stream] Enhanced capture_lead result with original question:', captureLeadOriginalQuestion);
          }
          
          // For list_available_slots with slots, tell AI that a visual calendar UI will show the options
          // Only add this note when the client supports calendar UI (chat channels, not voice/SMS)
          if (toolName === 'list_available_slots' && appointmentSlotsData && context.supportsCalendarUI) {
            const enhancedResult = {
              ...result,
              _ui_note: `IMPORTANT: A visual calendar UI will automatically display these time slots to the user. DO NOT list the individual time slots in your text response. Just give a brief friendly intro like "Here are the available appointment slots - please select a date and time that works for you!" CRITICAL: Do NOT include any bracketed placeholder text like "[Calendar will show]" or "[Visual Calendar UI will display the options]" - the calendar renders automatically, so your response should be clean natural text only.`
            };
            toolResultContent = JSON.stringify(enhancedResult);
            console.log('[Chat Stream] Enhanced list_available_slots result with calendar UI note');
          }

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: toolResultContent
          });
        }

        // Send product data for special rendering (with pagination for "Show More" feature)
        if (productData) {
          yield { 
            type: 'products', 
            data: JSON.stringify({
              items: productData,
              pagination: productPagination,
              searchQuery: productSearchQuery
            })
          };
        }
        
        if (jobsData && jobsData.length > 0) {
          yield {
            type: 'jobs',
            data: JSON.stringify({
              items: jobsData,
              applicantId: jobsApplicantId
            })
          };
        }

        // Send appointment slots for calendar UI rendering
        if (appointmentSlotsData) {
          yield { 
            type: 'appointment_slots', 
            data: JSON.stringify(appointmentSlotsData)
          };
        }

        // Track tool names for fallback logic
        const toolNames = toolCalls.map((tc: any) => tc.function.name);
        
        // Include system context in messages so continueToolConversation has proper
        // persona/instructions (e.g. K12 tutor prompt). Without this, the generic
        // "Chroney business chatbot" prompt is injected, which declines educational questions.
        const messagesWithSystem = [
          { role: 'system' as const, content: systemContext },
          ...messages
        ];
        
        // When K12 tools already returned data, don't pass tools to the continuation
        // call. Otherwise the AI tries to call another tool (e.g. get_faqs) instead of
        // synthesizing an answer from the K12 content already in the messages.
        const hasK12ToolResult = toolNames.some(n => n === 'fetch_k12_topic' || n === 'fetch_k12_questions');
        const continuationTools = hasK12ToolResult ? [] : relevantTools;
        
        // Always use AI to generate response for proper language matching
        // AI naturally matches user's language and provides contextual responses
        const finalResponse = await llamaService.continueToolConversation(
          messagesWithSystem, 
          continuationTools,
          context.personality || 'friendly',
          context.openaiApiKey || undefined,
          context.businessAccountId,
          context.preferredLanguage,
          context.responseLength || 'balanced'
        );
        let finalContent = finalResponse.content || '';
        
        // Context-aware fallback message if content is empty
        if (!finalContent || finalContent.trim() === '') {
          // Generate smart fallback based on what tools were called (toolNames already defined above)
          
          if (toolNames.includes('capture_lead')) {
            // Only thank them if they actually provided contact info
            // If no real data was captured, they may have just expressed a preference (e.g., "via email please")
            if (captureLeadHadRealData) {
              // AI-DRIVEN POST-CAPTURE: Smart handling based on conversation context
              console.log('[Chat Stream] Lead captured - determining post-capture strategy');
              
              const updatedHistory = conversationMemory.getConversationHistory(context.userId);
              const originalQuestion = this.extractLastSubstantiveQuestion(updatedHistory, userMessage);
              const lastAssistantMessage = updatedHistory.filter(m => m.role === 'assistant').slice(-1)[0];
              const freshLead = await storage.getLeadByConversation(conversationId, context.businessAccountId);
              
              // KEY DECISION: Was the previous response asking for contact info (fallback flow)?
              // If yes: The AI already couldn't answer, so just confirm lead capture
              // If no: The AI asked for contact as part of start-timing, so try to answer with tools
              const previousAskedForContact = lastAssistantMessage?.content && 
                this.isContactRequestMessage(lastAssistantMessage.content);
              
              if (previousAskedForContact) {
                // FALLBACK FLOW: AI previously couldn't answer and asked for contact
                // Don't re-try - just confirm team will help
                console.log('[Chat Stream] Previous response was contact request (fallback). Using AI-driven confirmation.');
                finalContent = await this.generatePostCaptureResponse(
                  originalQuestion,
                  {
                    phone: freshLead?.phone || undefined,
                    email: freshLead?.email || undefined,
                    name: freshLead?.name || undefined
                  },
                  lastAssistantMessage?.content || null,
                  context.businessAccountId,
                  context.openaiApiKey || undefined
                );
              } else if (originalQuestion) {
                // START-TIMING FLOW: AI asked for contact first, now try to answer the question
                console.log('[Chat Stream] Previous response was NOT contact request. Trying to answer:', originalQuestion);
                
                try {
                  // Use tool-aware response to actually answer the question
                  const nonLeadTools = relevantTools.filter((t: any) => t.function.name !== 'capture_lead');
                  const questionResponse = await llamaService.generateToolAwareResponse(
                    originalQuestion,
                    nonLeadTools,
                    updatedHistory,
                    '',
                    context.personality || 'friendly',
                    context.openaiApiKey || undefined,
                    context.businessAccountId,
                    false,
                    context.responseLength || 'balanced'
                  );
                  
                  if (questionResponse.tool_calls && questionResponse.tool_calls.length > 0) {
                    // AI needs tools - execute them
                    console.log('[Chat Stream] Post-lead: AI needs tools to answer');
                    const toolResult = await this.handleToolCalls(
                      questionResponse, context, originalQuestion, nonLeadTools, appointmentsEnabled, true, systemContext
                    );
                    
                    // Check if tool result is a deflection/fallback - if so, use AI confirmation instead
                    // This prevents asking for contact info again after it was just captured
                    if (this.isDeflectionResponse(toolResult.response) || toolResult.response.includes('[[FALLBACK]]')) {
                      console.log('[Chat Stream] Post-lead: Tool result was deflection, using AI confirmation');
                      finalContent = await this.generatePostCaptureResponse(
                        originalQuestion,
                        { phone: freshLead?.phone || undefined, email: freshLead?.email || undefined, name: freshLead?.name || undefined },
                        lastAssistantMessage?.content || null,
                        context.businessAccountId,
                        context.openaiApiKey || undefined
                      );
                    } else {
                      finalContent = this.stripFallbackMarker(toolResult.response);
                    }
                    
                    // Yield products if returned (with pagination and searchQuery for "Show More" feature)
                    if (toolResult.products && toolResult.products.length > 0) {
                      yield { 
                        type: 'products', 
                        data: JSON.stringify({ 
                          items: toolResult.products,
                          pagination: toolResult.pagination,
                          searchQuery: toolResult.searchQuery
                        }) 
                      };
                    }
                    
                    // Yield appointment slots if returned (for calendar UI)
                    if (toolResult.appointmentSlots) {
                      yield { type: 'appointment_slots', data: JSON.stringify(toolResult.appointmentSlots) };
                    }
                    
                    // Yield next form step if returned (for form journey UI)
                    if (toolResult.nextFormStep) {
                      console.log('[Chat Stream] Yielding next form step:', toolResult.nextFormStep.questionText?.substring(0, 30));
                      // Include conversationId so client can track which conversation to use for form step submission
                      yield { type: 'form_step', data: JSON.stringify({ ...toolResult.nextFormStep, conversationId }) };
                    }
                  } else if (questionResponse.content && questionResponse.content.trim()) {
                    // AI answered directly - check for deflection
                    if (this.isDeflectionResponse(questionResponse.content) || questionResponse.content.includes('[[FALLBACK]]')) {
                      console.log('[Chat Stream] Post-lead: Direct response was deflection, using AI confirmation');
                      finalContent = await this.generatePostCaptureResponse(
                        originalQuestion,
                        { phone: freshLead?.phone || undefined, email: freshLead?.email || undefined, name: freshLead?.name || undefined },
                        lastAssistantMessage?.content || null,
                        context.businessAccountId,
                        context.openaiApiKey || undefined
                      );
                    } else {
                      finalContent = this.stripFallbackMarker(questionResponse.content);
                    }
                  } else {
                    // AI still couldn't answer - use AI-driven confirmation
                    finalContent = await this.generatePostCaptureResponse(
                      originalQuestion,
                      { phone: freshLead?.phone || undefined, email: freshLead?.email || undefined, name: freshLead?.name || undefined },
                      lastAssistantMessage?.content || null,
                      context.businessAccountId,
                      context.openaiApiKey || undefined
                    );
                  }
                } catch (err) {
                  console.error('[Chat Stream] Error in post-lead tool-aware response:', err);
                  finalContent = "Thank you for sharing your details! I'm looking into your question now.";
                }
              } else {
                // No substantive question - just thank them
                finalContent = "Thank you for sharing your details! I'm here to help with any questions you have.";
              }
              
              console.log('[Chat Stream] Post-capture response generated');
            } else {
              // User expressed preference but didn't provide actual contact info
              // Check if they mentioned email preference
              const userMsgLower = userMessage.toLowerCase();
              if (userMsgLower.includes('mail') || userMsgLower.includes('email')) {
                finalContent = "Sure! Could you please share your email address so I can send you the details?";
              } else if (userMsgLower.includes('call') || userMsgLower.includes('phone')) {
                finalContent = "Sure! Could you please share your phone number so we can arrange a callback?";
              } else {
                finalContent = "I'd be happy to help! Could you please share your contact details?";
              }
              console.log('[Chat Stream] capture_lead called without real data, asking for contact info instead of thanking');
            }
          } else if (toolNames.includes('get_products')) {
            if (!productData || !Array.isArray(productData) || productData.length === 0) {
              // No products found - apologize naturally
              finalContent = "Sorry, I couldn't find any products matching your request.";
            }
            // Products found: pass through AI's brief acknowledgment (prompt instructs a brief reply)
          } else if (toolNames.includes('get_faqs')) {
            // RELEVANCE GATE: Check if FAQ results are actually relevant to the query
            if (faqData && Array.isArray(faqData) && faqData.length > 0) {
              console.log('[Chat Stream] Empty response after get_faqs, checking FAQ relevance');
              const topFaq = faqData[0];
              
              if (topFaq && topFaq.answer) {
                // Check relevance before using the FAQ
                const relevanceCheck = this.checkRelevance(
                  userMessage,
                  { question: topFaq.question, answer: topFaq.answer },
                  'faq'
                );
                
                if (relevanceCheck.isRelevant) {
                  // FAQ is relevant - use it
                  finalContent = topFaq.answer;
                  console.log(`[Relevance Gate] FAQ PASSED (${relevanceCheck.score}%): ${relevanceCheck.reason}`);
                  console.log('[Chat Stream] Using top FAQ answer:', finalContent.substring(0, 100));
                } else {
                  // FAQ doesn't match the query - use custom fallback template
                  console.log(`[Relevance Gate] FAQ FAILED (${relevanceCheck.score}%): ${relevanceCheck.reason}`);
                  console.log('[Chat Stream] FAQ does not match query, routing to custom fallback');
                  
                  const fallbackInstructions = this.fallbackInstructionsCache.get(context.businessAccountId);
                  if (fallbackInstructions && fallbackInstructions.length > 0) {
                    let fallbackTemplate = fallbackInstructions[0];
                    fallbackTemplate = this.processFallbackPlaceholders(fallbackTemplate, existingLead);
                    const rephrased = await this.rephraseFallbackMessage(
                      fallbackTemplate,
                      userMessage,
                      context.businessAccountId,
                      context.openaiApiKey || undefined,
                      existingLead
                    );
                    finalContent = rephrased;
                  } else {
                    // No custom fallback - use positive, solution-oriented response
                    finalContent = "I'd be happy to connect you with our team who can assist you with this. Could you share your contact details so they can reach out?";
                  }
                }
              } else {
                finalContent = "I found some information but couldn't format it properly. Could you try asking again?";
              }
            } else {
              // No FAQ data at all - use fallback
              const fallbackInstructions = this.fallbackInstructionsCache.get(context.businessAccountId);
              if (fallbackInstructions && fallbackInstructions.length > 0) {
                let fallbackTemplate = fallbackInstructions[0];
                fallbackTemplate = this.processFallbackPlaceholders(fallbackTemplate, existingLead);
                const rephrased = await this.rephraseFallbackMessage(
                  fallbackTemplate,
                  userMessage,
                  context.businessAccountId,
                  context.openaiApiKey || undefined,
                  existingLead
                );
                finalContent = rephrased;
              } else {
                finalContent = "I couldn't find specific information about that. Could you try rephrasing your question?";
              }
            }
          } else if (toolNames.includes('book_appointment')) {
            finalContent = "I've processed your appointment request.";
          } else if (toolNames.includes('list_available_slots')) {
            finalContent = "I've checked the available time slots for you.";
          } else if (toolNames.includes('fetch_k12_topic') || toolNames.includes('fetch_k12_questions')) {
            const k12ToolCallIds = toolCalls
              .filter((tc: any) => tc.function.name === 'fetch_k12_topic' || tc.function.name === 'fetch_k12_questions')
              .map((tc: any) => tc.id);
            const k12ToolMsg = messages.find(m => m.role === 'tool' && k12ToolCallIds.includes(m.tool_call_id) && m.content);
            let k12Data: any = null;
            try { k12Data = k12ToolMsg ? JSON.parse(k12ToolMsg.content) : null; } catch {}
            if (k12Data?.success && k12Data.data && k12Data.data.length > 0) {
              const topic = k12Data.data[0];
              const contentSnippet = topic.content ? topic.content.substring(0, 500) : '';
              console.log('[Chat Stream] K12 fallback: using topic content for', topic.name);
              finalContent = `Here's what I found about **${topic.name}**:\n\n${contentSnippet}`;
            } else {
              finalContent = "I couldn't find specific curriculum content for that question. Could you try rephrasing it?";
            }
          } else {
            finalContent = "How can I assist you today?";
          }
          
          // Only log warning if we're using a fallback (not when intentionally empty for products)
          if (finalContent && finalContent.trim() !== '') {
            console.log('[Chat Stream] Using context-aware fallback:', finalContent);
          }
        }
        
        // SAFETY: Always strip [[FALLBACK]] marker before yielding (in case it leaked through)
        finalContent = this.stripFallbackMarker(finalContent);
        
        conversationMemory.storeMessage(context.userId, 'assistant', finalContent);
        
        // Extract product IDs for metadata storage
        const productIds = productData && Array.isArray(productData) 
          ? productData.map((p: any) => p.id).filter(Boolean) 
          : undefined;
        await this.storeMessageInDB(conversationId, 'assistant', finalContent, 
          productIds && productIds.length > 0 ? { productIds } : undefined);
        yield { type: 'final', data: finalContent };
      } else {
        // No tool calls, store the response
        console.log('[Chat Stream] WARNING: No tool calls made for question:', userMessage);
        
        // Check if this is a refusal after a contact info request - if so, answer the pending question
        const lowerUserMessage = userMessage.toLowerCase().trim();
        const isRefusal = /^(no|nope|nah|not now|skip|later|no thanks|maybe later|not interested|i m good|i m okay|no need|pass)$/i.test(lowerUserMessage) || 
                         (lowerUserMessage.length < 20 && /\b(no|nope|skip|later|not now)\b/i.test(lowerUserMessage));
        
        if (isRefusal) {
          // Check conversation history for pending question
          const history = conversationMemory.getConversationHistory(context.userId);
          const pendingQuestion = this.extractLastSubstantiveQuestion(history, userMessage);
          
          // Check if the previous AI response was already a fallback (asked for contact info)
          // If so, skip re-processing since it will just hit the same fallback again
          const lastAssistantMessage = history.filter(m => m.role === 'assistant').slice(-1)[0];
          const previousResponseWasFallback = lastAssistantMessage?.content && 
            this.isContactRequestMessage(lastAssistantMessage.content);
          
          if (previousResponseWasFallback) {
            console.log('[Chat Stream] Skipping re-processing - previous response was already a fallback (would hit same fallback again)');
          }
          
          if (pendingQuestion && !previousResponseWasFallback) {
            console.log('[Chat Stream] Detected refusal after contact request. Re-processing pending question:', pendingQuestion);
            
            try {
              // Fetch fresh lead data in case it was captured after the initial existingLead snapshot
              const freshLeadForRefusal = await storage.getLeadByConversation(conversationId, context.businessAccountId);
              console.log(`[Chat Stream] Post-refusal: Fetched fresh lead data. Phone: ${freshLeadForRefusal?.phone ? 'YES' : 'NO'}`);
              
              // Re-process the original question with FULL knowledge tools (not refusal-stripped tools)
              // aiTools[0] = get_products, aiTools[1] = get_faqs - use these directly
              const fullTools = [aiTools[0], aiTools[1]];
              
              const questionResponse = await llamaService.generateToolAwareResponse(
                pendingQuestion,
                fullTools,
                history,
                '',
                context.personality || 'friendly',
                context.openaiApiKey || undefined,
                context.businessAccountId,
                false,
                context.responseLength || 'balanced'
              );
              
              let finalAnswer = fullResponse; // Start with the refusal acknowledgment
              
              if (questionResponse.tool_calls && questionResponse.tool_calls.length > 0) {
                console.log('[Chat Stream] Post-refusal: AI needs tools, executing...');
                const toolResult = await this.handleToolCalls(
                  questionResponse,
                  context,
                  pendingQuestion,
                  fullTools,
                  appointmentsEnabled,
                  true,  // skipDBStore - response will be stored after processing
                  systemContext
                );
                
                // Check if the tool result is still a deflection - if so, use enhanced fallback
                if (this.isDeflectionResponse(toolResult.response)) {
                  console.log('[Chat Stream] Post-refusal: Tool result is deflection, applying enhanced fallback');
                  
                  const fallbackInstructions = this.fallbackInstructionsCache.get(context.businessAccountId);
                  
                  let fallbackTemplate = fallbackInstructions && fallbackInstructions.length > 0
                    ? fallbackInstructions[0]
                    : "I'll need to check with our team for the specific details. Could you please share your contact information so they can reach out to you?";
                  
                  fallbackTemplate = this.processFallbackPlaceholders(fallbackTemplate, freshLeadForRefusal);
                  
                  const enhancedResponse = await this.rephraseFallbackMessage(
                    fallbackTemplate,
                    pendingQuestion,
                    context.businessAccountId,
                    context.openaiApiKey || undefined,
                    freshLeadForRefusal
                  );
                  finalAnswer = `No problem! ${enhancedResponse}`;
                } else {
                  // Strip [[FALLBACK]] marker if present
                  finalAnswer = `No problem! ${this.stripFallbackMarker(toolResult.response)}`;
                }
                
                // Track products for metadata storage
                const refusalProductIds = toolResult.products && toolResult.products.length > 0
                  ? toolResult.products.map((p: any) => p.id).filter(Boolean)
                  : undefined;
                
                if (toolResult.products && toolResult.products.length > 0) {
                  yield { 
                    type: 'products', 
                    data: JSON.stringify({ 
                      items: toolResult.products,
                      pagination: toolResult.pagination,
                      searchQuery: toolResult.searchQuery
                    }) 
                  };
                }
                
                // Yield appointment slots if returned (for calendar UI)
                if (toolResult.appointmentSlots) {
                  yield { type: 'appointment_slots', data: JSON.stringify(toolResult.appointmentSlots) };
                }
                
                // Yield next form step if returned (for form journey UI)
                if (toolResult.nextFormStep) {
                  console.log('[Chat Stream] Yielding next form step:', toolResult.nextFormStep.questionText?.substring(0, 30));
                  // Include conversationId so client can track which conversation to use for form step submission
                  yield { type: 'form_step', data: JSON.stringify({ ...toolResult.nextFormStep, conversationId }) };
                }
                
                // Store message with product IDs in metadata
                conversationMemory.storeMessage(context.userId, 'assistant', finalAnswer);
                await this.storeMessageInDB(conversationId, 'assistant', finalAnswer,
                  refusalProductIds && refusalProductIds.length > 0 ? { productIds: refusalProductIds } : undefined);
                yield { type: 'final', data: finalAnswer };
                
                // Skip the normal flow since we handled it
                yield { type: 'done', data: '' };
                return;
              } else if (questionResponse.content && questionResponse.content.trim()) {
                // Check if the content is a deflection
                if (this.isDeflectionResponse(questionResponse.content)) {
                  console.log('[Chat Stream] Post-refusal: Direct response is deflection, applying enhanced fallback');
                  const fallbackInstructions = this.fallbackInstructionsCache.get(context.businessAccountId);
                  
                  let fallbackTemplate = fallbackInstructions && fallbackInstructions.length > 0
                    ? fallbackInstructions[0]
                    : "I'll need to check with our team for the specific details. Could you please share your contact information so they can reach out to you?";
                  
                  fallbackTemplate = this.processFallbackPlaceholders(fallbackTemplate, freshLeadForRefusal);
                  
                  const enhancedResponse = await this.rephraseFallbackMessage(
                    fallbackTemplate,
                    pendingQuestion,
                    context.businessAccountId,
                    context.openaiApiKey || undefined,
                    freshLeadForRefusal
                  );
                  finalAnswer = `No problem! ${enhancedResponse}`;
                } else {
                  // Strip [[FALLBACK]] marker if present
                  finalAnswer = `No problem! ${this.stripFallbackMarker(questionResponse.content)}`;
                }
              }
              
              conversationMemory.storeMessage(context.userId, 'assistant', finalAnswer);
              await this.storeMessageInDB(conversationId, 'assistant', finalAnswer);
              yield { type: 'final', data: finalAnswer };
              
              // Skip the normal flow since we handled it
              yield { type: 'done', data: '' };
              return;
            } catch (err) {
              console.error('[Chat Stream] Error re-processing after refusal:', err);
              // Fall through to normal handling
            }
          }
        }
        
        // RELEVANCE GATE: Check if AI returned empty or deflection without tool calls
        // This means AI couldn't answer the question - route to custom fallback template
        let finalResponse = fullResponse;
        
        if (!fullResponse || !fullResponse.trim() || this.isDeflectionResponse(fullResponse)) {
          console.log('[Relevance Gate] No-tools path: AI returned empty or deflection, routing to custom fallback');
          
          if (fullResponse && this.isDeflectionResponse(fullResponse)) {
            await this.saveToQuestionBank(
              context.businessAccountId,
              conversationId,
              userMessage,
              fullResponse
            );
          }
          
          const fallbackInstructions = this.fallbackInstructionsCache.get(context.businessAccountId);
          if (fallbackInstructions && fallbackInstructions.length > 0) {
            let fallbackTemplate = fallbackInstructions[0];
            fallbackTemplate = this.processFallbackPlaceholders(fallbackTemplate, existingLead);
            const rephrased = await this.rephraseFallbackMessage(
              fallbackTemplate,
              userMessage,
              context.businessAccountId,
              context.openaiApiKey || undefined,
              existingLead
            );
            finalResponse = rephrased;
          } else if (!fullResponse || !fullResponse.trim()) {
            finalResponse = "I'd be happy to connect you with our team who can help with this. Could you share your contact details so they can reach out?";
          }
        }
        
        // SAFETY: Always strip [[FALLBACK]] marker before storing (in case it leaked through)
        finalResponse = this.stripFallbackMarker(finalResponse);
        
        conversationMemory.storeMessage(context.userId, 'assistant', finalResponse);
        await this.storeMessageInDB(conversationId, 'assistant', finalResponse);

        // If content was never streamed to the frontend (e.g. Gemini signaled tool calls but
        // sent no arguments, so buffered content was discarded), send the finalResponse now.
        if (!contentAlreadyYielded && finalResponse && finalResponse.trim()) {
          console.log('[Chat Stream] Yielding finalResponse that was not yet sent to frontend (Gemini empty tool-call guard)');
          yield { type: 'content', data: finalResponse };
        }
      }

      // Check for discount eligibility and send nudge if applicable
      if (context.visitorSessionId) {
        try {
          const nudge = await checkDiscountEligibility(
            context.businessAccountId,
            context.visitorSessionId
          );
          
          if (nudge) {
            console.log('[Discount Nudge] Sending offer to session:', context.visitorSessionId, nudge);
            yield { 
              type: 'discount_nudge', 
              data: {
                offerId: nudge.offerId,
                discountCode: nudge.discountCode,
                discountPercentage: nudge.discountPercentage,
                message: nudge.message,
                expiresAt: nudge.expiresAt,
                productId: nudge.productId
              }
            };
          }
        } catch (err) {
          console.error('[Discount Nudge] Error checking eligibility:', err);
        }
      }

      // Auto-categorize and summarize conversation after sufficient activity (async, non-blocking)
      this.autoCategorizeConversationAsync(conversationId, context.businessAccountId, context.openaiApiKey);
      this.autoSummarizeConversationAsync(conversationId, context.businessAccountId, context.openaiApiKey);

      yield { type: 'done', data: '' };
    } catch (error: any) {
      console.error('Chat streaming error:', error);
      yield { type: 'error', data: error.message };
    }
  }

  clearConversation(userId: string, businessAccountId: string) {
    conversationMemory.clearConversation(userId);
    // Clear active conversation tracking to start a new conversation next time
    const sessionKey = `${userId}_${businessAccountId}`;
    activeConversations.delete(sessionKey);
  }

  // Get active conversation ID for a user session (returns null if no active conversation)
  async getActiveConversationId(userId: string, businessAccountId: string): Promise<string | null> {
    const sessionKey = `${userId}_${businessAccountId}`;
    return activeConversations.get(sessionKey) || null;
  }

  // Phase 3: Optimized context building with caching (5-minute TTL) and parallel loading
  private async buildEnrichedContext(context: ChatContext): Promise<string> {
    const startTime = Date.now();
    
    // IMPORTANT: customInstructions are NOT cached because they are passed dynamically 
    // with each request and must always be fresh (user may update them at any time)
    let customInstructionsContext = '';
    let fallbackInstructions: string[] = [];
    
    if (context.customInstructions && context.customInstructions.trim()) {
      try {
        // Try to parse as JSON array (new format)
        const instructions = JSON.parse(context.customInstructions);
        if (Array.isArray(instructions) && instructions.length > 0) {
          // Separate instructions by type
          const alwaysActiveInstructions = instructions.filter((instr: any) => instr.type === 'always' || !instr.type);
          const conditionalInstructions = instructions.filter((instr: any) => instr.type === 'conditional');
          fallbackInstructions = instructions
            .filter((instr: any) => instr.type === 'fallback')
            .map((instr: any) => instr.text);
          
          // Build always-active instructions context
          if (alwaysActiveInstructions.length > 0) {
            const formattedAlwaysActive = alwaysActiveInstructions
              .map((instr: any, index: number) => `${index + 1}. ${instr.text}`)
              .join('\n');
            customInstructionsContext = `CUSTOM BUSINESS INSTRUCTIONS:\nFollow these specific instructions for this business:\n${formattedAlwaysActive}\n\n`;
          }
          
          // Add conditional instructions with their trigger keywords
          if (conditionalInstructions.length > 0) {
            const formattedConditional = conditionalInstructions
              .map((instr: any) => {
                const keywords = instr.keywords?.join(', ') || '';
                return `- When user mentions [${keywords}]: ${instr.text}`;
              })
              .join('\n');
            customInstructionsContext += `CONDITIONAL INSTRUCTIONS (apply when keywords are mentioned):\n${formattedConditional}\n\n`;
          }
          
          // Store fallback instructions in context for later use
          if (fallbackInstructions.length > 0) {
            // Fallback instructions are NOT added to regular context
            // They will be applied only when AI cannot answer
            console.log(`[Context Build] Found ${fallbackInstructions.length} fallback instruction(s) for unknown questions`);
          }
          
          console.log(`[Context Build] Loaded ${alwaysActiveInstructions.length} always-active, ${conditionalInstructions.length} conditional, ${fallbackInstructions.length} fallback instructions (FRESH, not cached)`);
        }
      } catch {
        // Fallback to plain text format (legacy)
        customInstructionsContext = `CUSTOM BUSINESS INSTRUCTIONS:\nFollow these specific instructions for this business:\n${context.customInstructions}\n\n`;
        console.log(`[Context Build] Loaded legacy custom instructions (FRESH, not cached)`);
      }
    }
    
    // Store or clear fallback instructions for use when deflection is detected
    // IMPORTANT: Always update the cache to prevent stale fallback instructions from being applied
    if (fallbackInstructions.length > 0) {
      this.fallbackInstructionsCache.set(context.businessAccountId, fallbackInstructions);
    } else {
      // Clear cache when no fallback instructions exist (user may have deleted them)
      this.fallbackInstructionsCache.delete(context.businessAccountId);
    }
    
    // Phase 3 Task 8: Use cache for business context (FAQs, settings, etc.)
    // NOTE: customInstructions are handled separately above and prepended to the final result
    const cacheKey = BusinessContextCache.KEYS.BUSINESS_CONTEXT(context.businessAccountId);
    
    const businessContext = await businessContextCache.getOrFetch(cacheKey, async () => {
      let enrichedContext = '';

      // PARALLEL DATA LOADING: Load all database queries simultaneously for 50-60% faster performance
      console.log('[Context Build] Starting parallel data loading...');
      const parallelLoadStart = Date.now();
      
      const [
        widgetSettingsResult,
        productsResult,
        faqsResult,
        websiteContentResult,
        analyzedPagesResult,
        trainingDocsResult,
        chatMenuItemsResult
      ] = await Promise.allSettled([
        storage.getWidgetSettings(context.businessAccountId),
        storage.getAllProducts(context.businessAccountId),
        storage.getAllFaqs(context.businessAccountId),
        (async () => {
          const { websiteAnalysisService } = await import("./websiteAnalysisService");
          return await websiteAnalysisService.getAnalyzedContent(context.businessAccountId);
        })(),
        storage.getAnalyzedPages(context.businessAccountId),
        storage.getTrainingDocuments(context.businessAccountId),
        storage.getChatMenuItems(context.businessAccountId)
      ]);

      // Extract results from Promise.allSettled
      const widgetSettings = widgetSettingsResult.status === 'fulfilled' ? widgetSettingsResult.value : null;
      const products = productsResult.status === 'fulfilled' ? productsResult.value : [];
      const businessFaqs = faqsResult.status === 'fulfilled' ? faqsResult.value : [];
      const websiteContent = websiteContentResult.status === 'fulfilled' ? websiteContentResult.value : null;
      const analyzedPages = analyzedPagesResult.status === 'fulfilled' ? analyzedPagesResult.value : [];
      const trainingDocs = trainingDocsResult.status === 'fulfilled' ? trainingDocsResult.value : [];

      const parallelLoadTime = Date.now() - parallelLoadStart;
      console.log(`[Context Build] Parallel data loading completed in ${parallelLoadTime}ms`);

      // Log any failures (non-blocking)
      if (widgetSettingsResult.status === 'rejected') {
        console.error('[Context Build] Failed to load widgetSettings:', widgetSettingsResult.reason);
      }
      if (productsResult.status === 'rejected') {
        console.error('[Context Build] Failed to load products:', productsResult.reason);
      }
      if (faqsResult.status === 'rejected') {
        console.error('[Context Build] Failed to load FAQs:', faqsResult.reason);
      }
      if (websiteContentResult.status === 'rejected') {
        console.error('[Context Build] Failed to load website content:', websiteContentResult.reason);
      }
      if (analyzedPagesResult.status === 'rejected') {
        console.error('[Context Build] Failed to load analyzed pages:', analyzedPagesResult.reason);
      }
      if (trainingDocsResult.status === 'rejected') {
        console.error('[Context Build] Failed to load training documents:', trainingDocsResult.reason);
      }

      const menuItems = chatMenuItemsResult.status === 'fulfilled' ? chatMenuItemsResult.value : [];
      const brochureLinks: { label: string; url: string; menuTitle: string }[] = [];
      for (const item of menuItems) {
        if (item.itemType === 'detail' && item.actionValue) {
          try {
            const config = JSON.parse(item.actionValue);
            if (config.brochureUrl) {
              brochureLinks.push({
                label: config.brochureLabel || 'Download Brochure',
                url: config.brochureUrl.startsWith('http') ? config.brochureUrl : `https://${config.brochureUrl}`,
                menuTitle: item.title
              });
            }
          } catch {}
        }
        if (item.itemType === 'url' && item.actionValue) {
          const lowerTitle = item.title.toLowerCase();
          if (lowerTitle.includes('brochure') || lowerTitle.includes('download') || lowerTitle.includes('catalog') || lowerTitle.includes('catalogue')) {
            brochureLinks.push({
              label: item.title,
              url: item.actionValue.startsWith('http') ? item.actionValue : `https://${item.actionValue}`,
              menuTitle: item.title
            });
          }
        }
      }
      if (brochureLinks.length > 0) {
        enrichedContext += `\nDOWNLOADABLE RESOURCES:\n`;
        for (const link of brochureLinks) {
          enrichedContext += `- ${link.label}: ${link.url}\n`;
        }
        enrichedContext += `When users ask for brochure/catalog/download, provide the EXACT URL above as a clickable markdown link like [${brochureLinks[0].label}](${brochureLinks[0].url})\n\n`;
      }

      // Add lead training configuration (from Train Chroney page) — uses shared utility
      try {
        if (widgetSettings?.leadTrainingConfig) {
          const leadPrompt = buildLeadTrainingPrompt(widgetSettings.leadTrainingConfig);
          if (leadPrompt) {
            enrichedContext += leadPrompt;
          }
        }
      } catch (error) {
        console.error('[Chat Context] Error loading lead training config:', error);
      }

      // Add appointment suggest trigger rules
      try {
        if (widgetSettings?.appointmentSuggestRules && Array.isArray(widgetSettings.appointmentSuggestRules)) {
          const enabledRules = widgetSettings.appointmentSuggestRules.filter((r: any) => r.enabled);
          if (enabledRules.length > 0) {
            enrichedContext += `APPOINTMENT SUGGESTION TRIGGERS:\n`;
            enrichedContext += `When you detect these keywords in the user's message, proactively suggest booking an appointment using the specified prompt:\n`;
            enabledRules.forEach((rule: any, index: number) => {
              const keywords = Array.isArray(rule.keywords) ? rule.keywords.join(', ') : '';
              enrichedContext += `${index + 1}. Keywords: [${keywords}] → Respond with: "${rule.prompt}"\n`;
            });
            enrichedContext += `\nIMPORTANT: Only suggest once per conversation. After suggesting, wait for user's response before offering again.\n\n`;
          }
        }
      } catch (error) {
        console.error('[Chat Context] Error loading appointment suggest rules:', error);
      }

      // Add currency information
      if (context.currency && context.currencySymbol) {
        enrichedContext += `CURRENCY SETTINGS:\nAll prices should be referenced in ${context.currency} (${context.currencySymbol}). When discussing prices, always use ${context.currencySymbol} as the currency symbol.\n\n`;
      }

      // Add company description
      if (context.companyDescription) {
        enrichedContext += `COMPANY INFORMATION:\n${context.companyDescription}\n\n`;
      }

      // OPTIMIZATION: Product catalog removed from base context
      // The get_products tool handles product queries via semantic search
      // This reduces prompt size by ~80% and speeds up responses
      if (products.length > 0) {
        enrichedContext += `PRODUCT AVAILABILITY:\nThis business has ${products.length} products in their catalog. Use the get_products tool to search and retrieve products when customers ask about products, pricing, or recommendations.\n\n`;
      }

      // OPTIMIZATION: FAQ dump removed from base context  
      // The get_faqs tool handles FAQ queries via vector search
      // Only relevant FAQs are retrieved per query
      if (businessFaqs.length > 0) {
        enrichedContext += `KNOWLEDGE BASE:\nThis business has ${businessFaqs.length} FAQ entries. Use the get_faqs tool to search for answers when customers ask questions. Answer naturally without mentioning FAQs or knowledge base.\n\n`;
      }

      // Add website analysis if available
      // Data already loaded in parallel above
      try {
        if (websiteContent) {
          enrichedContext += `BUSINESS KNOWLEDGE (from website analysis):\n`;
          enrichedContext += `You have comprehensive knowledge about this business extracted from their website.\n\n`;
          
          if (websiteContent.businessName) {
            enrichedContext += `Business Name: ${websiteContent.businessName}\n\n`;
          }
          
          if (websiteContent.businessDescription) {
            enrichedContext += `About: ${websiteContent.businessDescription}\n\n`;
          }
          
          if (websiteContent.targetAudience) {
            enrichedContext += `Target Audience: ${websiteContent.targetAudience}\n\n`;
          }
          
          if (websiteContent.mainProducts && websiteContent.mainProducts.length > 0) {
            enrichedContext += `Main Products:\n${websiteContent.mainProducts.map(p => `- ${p}`).join('\n')}\n\n`;
          }
          
          if (websiteContent.mainServices && websiteContent.mainServices.length > 0) {
            enrichedContext += `Main Services:\n${websiteContent.mainServices.map(s => `- ${s}`).join('\n')}\n\n`;
          }
          
          if (websiteContent.keyFeatures && websiteContent.keyFeatures.length > 0) {
            enrichedContext += `Key Features:\n${websiteContent.keyFeatures.map(f => `- ${f}`).join('\n')}\n\n`;
          }
          
          if (websiteContent.uniqueSellingPoints && websiteContent.uniqueSellingPoints.length > 0) {
            enrichedContext += `Unique Selling Points:\n${websiteContent.uniqueSellingPoints.map(u => `- ${u}`).join('\n')}\n\n`;
          }
          
          if (websiteContent.contactInfo && (websiteContent.contactInfo.email || websiteContent.contactInfo.phone || websiteContent.contactInfo.address)) {
            enrichedContext += `Contact Information:\n`;
            if (websiteContent.contactInfo.email) enrichedContext += `- Email: ${websiteContent.contactInfo.email}\n`;
            if (websiteContent.contactInfo.phone) enrichedContext += `- Phone: ${websiteContent.contactInfo.phone}\n`;
            if (websiteContent.contactInfo.address) enrichedContext += `- Address: ${websiteContent.contactInfo.address}\n`;
            enrichedContext += '\n';
          }
          
          if (websiteContent.businessHours) {
            enrichedContext += `Business Hours: ${websiteContent.businessHours}\n\n`;
          }
          
          if (websiteContent.pricingInfo) {
            enrichedContext += `Pricing: ${websiteContent.pricingInfo}\n\n`;
          }
          
          if (websiteContent.additionalInfo) {
            enrichedContext += `Additional Information: ${websiteContent.additionalInfo}\n\n`;
          }
          
          enrichedContext += `IMPORTANT: Use this website knowledge to provide accurate, context-aware responses about the business. Answer naturally without mentioning that you analyzed their website.\n\n`;
        }
      } catch (error) {
        console.error('[Chat Context] Error loading website analysis:', error);
      }

      // Add analyzed pages content (homepage, additional pages)
      // Data already loaded in parallel above
      try {
        if (analyzedPages && analyzedPages.length > 0) {
          enrichedContext += `DETAILED WEBSITE CONTENT:\n`;
          enrichedContext += `Below is detailed information extracted from ${analyzedPages.length} page(s) of the business website.\n\n`;
          
          let pagesLoaded = 0;
          for (const page of analyzedPages) {
            // Skip pages with no content or generic "no info" message
            if (!page.extractedContent || 
                page.extractedContent.trim() === '' || 
                page.extractedContent === 'No relevant business information found on this page.') {
              continue;
            }
            
            try {
              // Extract page name from URL (handle both absolute and relative URLs)
              let pageName = 'Page';
              try {
                // Try parsing as absolute URL first
                const url = new URL(page.pageUrl);
                const pathParts = url.pathname.split('/').filter(Boolean);
                pageName = pathParts[pathParts.length - 1] || 'Homepage';
              } catch {
                // Fallback for relative URLs (e.g., "/privacy-policy")
                const pathParts = page.pageUrl.split('/').filter(Boolean);
                pageName = pathParts[pathParts.length - 1] || 'Homepage';
              }
              
              enrichedContext += `--- ${pageName.toUpperCase()} PAGE ---\n`;
              enrichedContext += `${page.extractedContent}\n\n`;
              pagesLoaded++;
            } catch (pageError) {
              console.error(`[Chat Context] Error processing page ${page.pageUrl}:`, pageError);
              // Continue with other pages even if one fails
            }
          }
          
          if (pagesLoaded > 0) {
            console.log(`[Chat Context] Loaded ${pagesLoaded} analyzed page(s) into context`);
            enrichedContext += `IMPORTANT: Use all the above website content to answer customer questions accurately. This information comes from their actual website pages.\n\n`;
          } else {
            console.log(`[Chat Context] No valid analyzed pages content found to load`);
          }
        }
      } catch (error) {
        console.error('[Chat Context] Error loading analyzed pages:', error);
      }

      // Add training documents (PDF knowledge)
      // Data already loaded in parallel above
      try {
        const completedDocs = trainingDocs.filter(doc => doc.uploadStatus === 'completed');
        
        if (completedDocs.length > 0) {
          enrichedContext += `TRAINING DOCUMENTS KNOWLEDGE:\n`;
          enrichedContext += `The following information has been extracted from uploaded training documents:\n\n`;
          
          for (const doc of completedDocs) {
            if (doc.summary || doc.keyPoints) {
              enrichedContext += `--- ${doc.originalFilename} ---\n`;
              
              if (doc.summary) {
                enrichedContext += `Summary: ${doc.summary}\n\n`;
              }
              
              if (doc.keyPoints) {
                try {
                  const keyPoints = JSON.parse(doc.keyPoints);
                  if (Array.isArray(keyPoints) && keyPoints.length > 0) {
                    enrichedContext += `Key Points:\n`;
                    keyPoints.forEach((point: string, index: number) => {
                      enrichedContext += `${index + 1}. ${point}\n`;
                    });
                    enrichedContext += `\n`;
                  }
                } catch (parseError) {
                  console.error(`[Chat Context] Error parsing key points for ${doc.originalFilename}:`, parseError);
                }
              }
            }
          }
          
          console.log(`[Chat Context] Loaded ${completedDocs.length} training document(s) summaries into context`);
          enrichedContext += `IMPORTANT: Use this training document knowledge to provide accurate, informed responses. This information has been specifically provided to help answer customer questions.\n\n`;
        }
      } catch (error) {
        console.error('[Chat Context] Error loading training documents:', error);
      }

      return enrichedContext;
    });

    const elapsed = Date.now() - startTime;
    console.log(`[Context Build] Business context loaded in ${elapsed}ms`);
    console.log(`[Context Build] Cached context length: ${businessContext.length} characters`);
    console.log(`[Context Build] Has FAQs: ${businessContext.includes('BUSINESS KNOWLEDGE:')}`);
    console.log(`[Context Build] Context preview: ${businessContext.substring(0, 500)}...`);

    // Prepend custom instructions (ALWAYS FRESH, not cached) to the cached business context
    // This ensures instructions are always up-to-date even when cache returns old data
    // Add current date context so AI knows today's date for appointment booking and date-related queries
    // IMPORTANT: Use IST (Asia/Kolkata) timezone explicitly to ensure consistent date interpretation
    const now = new Date();
    const istDateFormatter = new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
    const istTimeFormatter = new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
    // Get ISO date in IST using formatToParts for robustness
    const istParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(now);
    const getPart = (type: string) => istParts.find(p => p.type === type)?.value || '';
    const isoDate = `${getPart('year')}-${getPart('month')}-${getPart('day')}`;
    
    const dateContext = `CURRENT DATE/TIME (IST - Indian Standard Time):
Today is ${istDateFormatter.format(now)} (${isoDate}) at ${istTimeFormatter.format(now)} IST.
IMPORTANT: Users booking appointments for future dates is completely normal and expected. Do NOT question, clarify, or confirm that a date is "in the future" - simply proceed with the booking flow by asking for their name and phone number.

`;

    let finalContext = dateContext + customInstructionsContext + businessContext;
    
    console.log(`[Context Build] Has Custom Instructions: ${finalContext.includes('CUSTOM BUSINESS INSTRUCTIONS')}`);
    console.log(`[Context Build] Custom instructions length: ${customInstructionsContext.length} characters`);

    if (context.k12EducationEnabled) {
      finalContext += `K12 EDUCATION MODE — TUTOR INSTRUCTIONS:
You are a friendly, encouraging educational tutor (study buddy). Your primary role is helping students learn and practice.
MANDATORY RULES:
1. For ANY academic, educational, or study-related question, you MUST call the fetch_k12_topic tool FIRST before responding. NEVER answer academic questions from general knowledge alone.
2. After explaining a topic, ALWAYS offer to show practice questions by calling fetch_k12_questions.
3. Base your explanations on the revision notes and content returned by the tools. If the tool returns content, use it as your primary source.
4. If no curriculum match is found, you may answer from general knowledge but mention that the specific topic wasn't found in the curriculum.
5. Use a supportive, Socratic teaching style — guide students to understand concepts rather than just giving bare answers.
6. You can respond to greetings and casual conversation naturally without calling tools.

`;
      console.log(`[Context Build] Added K12 education tutor prompt`);
    }

    if (context.jobPortalEnabled) {
      finalContext += `RECRUITMENT ASSISTANT MODE — JOB PORTAL INSTRUCTIONS:
You are a helpful recruitment assistant. Your primary role is helping visitors discover job openings and apply for positions.
MANDATORY RULES:
1. For ANY question about jobs, positions, openings, or careers, you MUST call the search_jobs tool FIRST. NEVER list jobs from general knowledge.
2. When a visitor uploads a resume (PDF), call parse_resume_and_match to extract their info and find matching positions.
3. When a visitor wants to apply to a specific job, use the apply_to_job tool.
4. Encourage visitors to upload their resume for better job matching — mention that you can analyze their skills and find the best fit.
5. Present job results naturally — mention key details like title, location, salary range, and job type.
6. If no matching jobs are found, let the visitor know and suggest they check back later or broaden their search.
7. You can respond to greetings and casual conversation naturally without calling tools.

`;
      console.log(`[Context Build] Added Job Portal recruitment assistant prompt`);
    }

    if (context.journeyConversationalGuidelines && context.journeyConversationalGuidelines.trim()) {
      finalContext += `JOURNEY-SPECIFIC CONVERSATIONAL GUIDELINES:\nWhile following the main business instructions above, also adhere to these additional guidelines specific to the current conversation journey:\n${context.journeyConversationalGuidelines}\n\n`;
      console.log(`[Context Build] Added journey-specific conversational guidelines`);
    }

    // Add starter Q&A context for guidance chatbots (per-conversation, not cached)
    // This provides predefined answers for common questions specific to the guidance rule
    if (context.starterQAContext && context.starterQAContext.trim()) {
      finalContext += `\n${context.starterQAContext}\n`;
      console.log(`[Context Build] Added guidance starter Q&A context`);
    }

    // CRITICAL: Add communication guidelines at the END for maximum AI compliance (recency bias)
    // AI models remember instructions at the end of prompts better than those at the beginning
    // Include the configured fallback message as the example response style
    const cachedFallbackInstructions = this.fallbackInstructionsCache.get(context.businessAccountId);
    const configuredFallback = cachedFallbackInstructions && cachedFallbackInstructions.length > 0
      ? cachedFallbackInstructions[0]
        .replace(/\{\{if_missing_phone\}\}/g, '')
        .replace(/\{\{\/if_missing_phone\}\}/g, '')
        .replace(/\{\{if_has_phone\}\}/g, '')
        .replace(/\{\{\/if_has_phone\}\}/g, '')
        .replace(/\{\{if_missing_email\}\}/g, '')
        .replace(/\{\{\/if_missing_email\}\}/g, '')
        .replace(/\{\{if_has_email\}\}/g, '')
        .replace(/\{\{\/if_has_email\}\}/g, '')
        .replace(/\{\{if_missing_name\}\}/g, '')
        .replace(/\{\{\/if_missing_name\}\}/g, '')
        .replace(/\{\{if_has_name\}\}/g, '')
        .replace(/\{\{\/if_has_name\}\}/g, '')
        .replace(/\n\s*\n/g, ' ')
        .trim()
      : null;
    
    const exampleResponse = configuredFallback 
      ? configuredFallback
      : "I need to pass this to our team to give you the right answer. Please share your mobile number so our team can contact you and help you quickly.";
    
    const communicationGuidelines = `

🚨 FINAL CRITICAL RULES - MUST FOLLOW 🚨
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🚫 ABSOLUTELY BANNED PHRASES - NEVER USE THESE UNDER ANY CIRCUMSTANCE:
❌ "I don't have information..."
❌ "I don't have specific information..."
❌ "I don't have [any word] information..."
❌ "I don't know..."
❌ "I'm not sure..."
❌ "I cannot answer..."
❌ "I cannot help..."
❌ "I'm unable to..."
❌ "That's outside my knowledge..."
❌ "I don't have details..."
❌ "I couldn't find..."
❌ "Unfortunately, I don't..."
❌ "I apologize, I don't have..."
❌ Any phrase starting with "I don't have" or "I cannot" or "I don't know"

⚠️ THIS IS THE #1 RULE - If you're about to say "I don't have" or "I don't know" - STOP and use the positive response below instead!

✅ WHEN YOU DON'T HAVE SPECIFIC INFORMATION, USE THIS EXACT STYLE:
"${exampleResponse}"

📝 MORE EXAMPLES OF POSITIVE RESPONSES:
✅ "Great question! Let me connect you with our team who can give you the exact details. May I have your mobile number?"
✅ "I'd be happy to help! Our team can provide you with accurate information on this. Please share your mobile number."
✅ "That's an excellent query! I'll have our team reach out with the right answer. What's your mobile number?"

🔴 WRONG: "I don't have specific fee information, but..."
🟢 RIGHT: "I need to pass this to our team to give you the right answer. Please share your mobile number."

🔴 WRONG: "I don't have information about that program..."  
🟢 RIGHT: "Great question! Let me connect you with our team who can guide you on this."

This rule is MANDATORY and overrides ALL other instructions. NEVER admit lack of knowledge - always redirect positively!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;
    finalContext += communicationGuidelines;

    return finalContext;
  }

  /**
   * Determine if a query needs deep RAG search for PDF documents
   * OPTIMIZED: Skip RAG by default since FAQ vector search handles most queries
   * Only use RAG when query explicitly references documents/PDFs
   */
  private shouldUseRAGSearch(userMessage: string): boolean {
    const cleanMessage = userMessage.toLowerCase().trim();
    
    // Skip RAG for short queries
    if (cleanMessage.length < 15) {
      return false;
    }

    // ONLY run RAG for queries that explicitly reference documents/PDFs
    const documentKeywords = [
      'document', 'pdf', 'file', 'uploaded', 'training document',
      'section', 'chapter', 'page', 'quote', 'said in the document',
      'according to the document', 'from the pdf', 'in the file'
    ];

    // Check if query explicitly references documents
    const referencesDocument = documentKeywords.some(keyword => cleanMessage.includes(keyword));
    
    if (referencesDocument) {
      console.log('[RAG Strategy] Query references documents - will use RAG');
      return true;
    }

    // DEFAULT: Skip RAG - FAQ vector search handles general queries
    return false;
  }

  /**
   * Add RAG-retrieved document chunks to context based on user's query
   * This runs outside the cache to use the current message for semantic search
   */
  private async addRAGContext(
    userMessage: string,
    businessAccountId: string
  ): Promise<string> {
    if (!userMessage || userMessage.trim().length < 5) {
      console.log(`[RAG] Skipping - message too short (${userMessage.trim().length} chars)`);
      return '';
    }

    try {
      console.log(`[RAG] Starting search for query: "${userMessage.substring(0, 80)}..."`);
      
      // Perform semantic search for relevant document chunks
      const relevantChunks = await vectorSearchService.search(
        userMessage,
        businessAccountId,
        5, // Top 5 chunks
        0.50 // 50% similarity threshold (lowered from 70% for better recall)
      );

      console.log(`[RAG] Search completed - found ${relevantChunks.length} chunks`);

      if (relevantChunks.length === 0) {
        console.log('[RAG] No relevant document chunks found for query');
        return '';
      }

      // Build RAG context from chunks
      let ragContext = `\n🔒 CRITICAL DOCUMENT KNOWLEDGE - HIGHEST PRIORITY:\n`;
      ragContext += `The following information was found in your business's training documents via semantic search.\n`;
      ragContext += `This is BUSINESS-SPECIFIC information that you MUST use to answer questions.\n\n`;

      relevantChunks.forEach((chunk, idx) => {
        ragContext += `[Document Excerpt ${idx + 1} from ${chunk.documentName}]:\n`;
        ragContext += `${chunk.chunkText}\n\n`;
      });

      ragContext += `🚨 MANDATORY INSTRUCTION:\n`;
      ragContext += `- The above document excerpts are BUSINESS-SPECIFIC knowledge provided by the business owner\n`;
      ragContext += `- You MUST use this information to answer the current question\n`;
      ragContext += `- This is NOT general knowledge - this is specific business documentation\n`;
      ragContext += `- Answer questions about this content naturally and accurately\n`;
      ragContext += `- Do NOT say "I don't have information" when the answer is clearly in the excerpts above\n\n`;

      console.log(`[RAG] Added ${relevantChunks.length} relevant chunks to context (avg similarity: ${(relevantChunks.reduce((sum, c) => sum + c.similarity, 0) / relevantChunks.length * 100).toFixed(1)}%)`);

      return ragContext;
    } catch (error: any) {
      console.error('[RAG] Error retrieving chunks:', error);
      return ''; // Fail gracefully - don't break chat if RAG fails
    }
  }
}

export const chatService = new ChatService();
