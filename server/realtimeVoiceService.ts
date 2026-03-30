import WebSocket from 'ws';
import OpenAI from 'openai';
import { storage } from './storage';
import { conversationMemory } from './conversationMemory';
import { aiTools } from './aiTools';
import { ToolExecutionService } from './services/toolExecutionService';
import { journeyOrchestrator } from './services/journeyOrchestrator';
import { journeyService } from './services/journeyService';
import { isElevenLabsVoice, getElevenLabsVoiceId, synthesizeSpeechStreaming } from './services/elevenlabsService';

interface VoiceConversation {
  clientWs: WebSocket; // WebSocket to client (browser)
  openaiWs: WebSocket | null; // WebSocket to OpenAI Realtime API
  businessAccountId: string;
  userId: string;
  openaiApiKey: string;
  sessionId: string | null;
  conversationId: string; // Database conversation ID - now required and used as key
  personality?: string;
  companyDescription?: string;
  currency?: string;
  currencySymbol?: string;
  customInstructions?: string;
  isProcessing: boolean;
  currentUserTranscript?: string; // Track current user message
  currentAITranscript?: string; // Accumulate AI response chunks
  lastHeartbeat: number; // Timestamp of last heartbeat
  heartbeatInterval?: NodeJS.Timeout; // Heartbeat timer
  // CRITICAL FIX BUG 4: Track journey responses per journey stepId to prevent race conditions
  // Maps journeyStepId -> {original: template question, responseId: OpenAI response.id, timestamp: when set}
  journeyResponseTracking: Map<string, {original: string, responseId: string, timestamp: number}>;
  currentResponseId?: string; // Track current OpenAI response.id
  pendingJourneyStepId?: string; // Temporary: next response will be journey with this stepId
  // OpenAI reconnection tracking
  reconnectAttempts: number; // Number of reconnection attempts
  reconnectTimeout?: NodeJS.Timeout; // Reconnection timer
  isReconnecting: boolean; // Flag to indicate if currently reconnecting
  selectedLanguage?: string;
  detectedLanguage?: string;
  textConversationId?: string;
  textHistoryInjected?: boolean;
  elevenlabsApiKey?: string;
  elevenlabsVoiceId?: string;
  openaiAudioFallbackBuffer?: Buffer[];
}

export class RealtimeVoiceService {
  private conversations: Map<string, VoiceConversation> = new Map(); // Now keyed by conversationId
  private readonly HEARTBEAT_INTERVAL = 30000; // 30 seconds
  private readonly HEARTBEAT_TIMEOUT = 180000; // 180 seconds - extended to handle mobile backgrounding and long AI responses
  private readonly MAX_RECONNECT_ATTEMPTS = 5; // Maximum reconnection attempts
  private readonly BASE_RECONNECT_DELAY = 1000; // Base delay for exponential backoff (1 second)
  private readonly MAX_RECONNECT_DELAY = 30000; // Maximum reconnection delay (30 seconds)

  constructor() {
    console.log('[RealtimeVoice] Service initialized with OpenAI Realtime API');
    // Start heartbeat monitor
    this.startHeartbeatMonitor();
  }

  isConfigured(): boolean {
    // Always configured since we only need OpenAI API key (no Deepgram needed)
    return true;
  }

  async handleConnection(clientWs: WebSocket, businessAccountId: string, userId: string, existingConversationId?: string, selectedLanguage?: string, textConversationId?: string) {
    console.log('[RealtimeVoice] New connection:', { businessAccountId, userId, existingConversationId });

    try {
      // CRITICAL FIX: Check if this is a reconnection with existing conversationId
      if (existingConversationId && this.conversations.has(existingConversationId)) {
        const conversation = this.conversations.get(existingConversationId)!;
        
        console.log('[RealtimeVoice] RECONNECTION detected - reusing existing session:', existingConversationId);
        
        // CRITICAL FIX BUG 1: Mark old socket as superseded BEFORE closing
        // This prevents the old socket's close handler from calling cleanupConversation()
        // which would send session_closed to the NEW socket and tear down the session
        if (conversation.clientWs && conversation.clientWs.readyState === WebSocket.OPEN) {
          (conversation.clientWs as any)._superseded = true;
          console.log('[RealtimeVoice] Marked old socket as superseded before closing');
          conversation.clientWs.close();
        }
        
        // Reattach new client WebSocket to existing conversation
        conversation.clientWs = clientWs;
        conversation.lastHeartbeat = Date.now(); // Update heartbeat
        if (selectedLanguage !== undefined) {
          conversation.selectedLanguage = selectedLanguage;
        }
        
        // Setup client handlers for new WebSocket
        this.setupClientHandlers(existingConversationId, conversation);
        
        // Restart heartbeat for this conversation
        this.startConversationHeartbeat(existingConversationId);
        
        // Send ready signal to client with same conversationId
        this.sendToClient(clientWs, { 
          type: 'ready',
          conversationId: existingConversationId,
          reconnected: true // Flag to indicate this was a reconnection
        });
        
        console.log('[RealtimeVoice] Reconnection successful - session resumed:', existingConversationId);
        return;
      }
      
      // NOT a reconnection OR conversation not found - create new session
      if (existingConversationId) {
        console.warn('[RealtimeVoice] Conversation not found for reconnection, creating new session:', existingConversationId);
      }
      
      const settings = await storage.getWidgetSettings(businessAccountId);
      const businessAccount = await storage.getBusinessAccount(businessAccountId);
      const openaiApiKey = await storage.getBusinessAccountOpenAIKey(businessAccountId);

      if (!openaiApiKey) {
        this.sendError(clientWs, 'OpenAI API key not configured for this business account');
        clientWs.close();
        return;
      }

      if (!businessAccount) {
        this.sendError(clientWs, 'Business account not found');
        clientWs.close();
        return;
      }

      const selectedVoice = settings?.voiceSelection || 'shimmer';
      let elevenlabsApiKey: string | undefined;
      let elevenlabsVoiceId: string | undefined;

      if (isElevenLabsVoice(selectedVoice)) {
        elevenlabsApiKey = businessAccount.elevenlabsApiKey || undefined;
        elevenlabsVoiceId = getElevenLabsVoiceId(selectedVoice) || undefined;
        if (!elevenlabsApiKey || !elevenlabsVoiceId) {
          console.warn('[RealtimeVoice] ElevenLabs voice selected but API key or voice ID missing, falling back to OpenAI shimmer');
        }
      }

      // Create database conversation record FIRST to get stable conversationId
      const dbConversation = await storage.createConversation({
        businessAccountId,
        title: 'Voice Chat'
      });

      const conversationId = dbConversation.id; // Stable identifier for entire session

      // Create conversation object (OpenAI WebSocket will be created when needed)
      const conversation: VoiceConversation = {
        clientWs,
        openaiWs: null,
        businessAccountId,
        userId,
        openaiApiKey,
        sessionId: null,
        conversationId: conversationId,
        personality: settings?.personality || 'friendly',
        companyDescription: businessAccount.description || '',
        currency: settings?.currency || 'USD',
        currencySymbol: settings?.currency === 'USD' ? '$' : '€',
        customInstructions: settings?.customInstructions || undefined,
        isProcessing: false,
        currentUserTranscript: '',
        currentAITranscript: '',
        lastHeartbeat: Date.now(),
        journeyResponseTracking: new Map(),
        reconnectAttempts: 0,
        isReconnecting: false,
        selectedLanguage,
        textConversationId,
        elevenlabsApiKey: elevenlabsApiKey && elevenlabsVoiceId ? elevenlabsApiKey : undefined,
        elevenlabsVoiceId: elevenlabsApiKey && elevenlabsVoiceId ? elevenlabsVoiceId : undefined,
      };

      // Use conversationId as the key (stable across reconnections)
      this.conversations.set(conversationId, conversation);
      
      console.log('[RealtimeVoice] Created conversation record:', conversationId);

      // Connect to OpenAI Realtime API
      await this.connectToOpenAI(conversationId, conversation);

      // Setup client WebSocket handlers
      this.setupClientHandlers(conversationId, conversation);

      // Start heartbeat for this conversation
      this.startConversationHeartbeat(conversationId);

      // Send ready signal to client WITH conversationId for reconnection
      this.sendToClient(clientWs, { 
        type: 'ready',
        conversationId: conversationId 
      });

      console.log('[RealtimeVoice] Connection established:', conversationId);

    } catch (error: any) {
      console.error('[RealtimeVoice] Connection error:', error);
      this.sendError(clientWs, error.message || 'Failed to initialize voice conversation');
      clientWs.close();
    }
  }

  private touchActivity(conversation: VoiceConversation) {
    conversation.lastHeartbeat = Date.now();
  }

  private startHeartbeatMonitor() {
    setInterval(() => {
      const now = Date.now();
      this.conversations.forEach((conversation, conversationId) => {
        const timeSinceLastActivity = now - conversation.lastHeartbeat;
        
        if (timeSinceLastActivity > this.HEARTBEAT_TIMEOUT) {
          console.log(`[RealtimeVoice] Heartbeat timeout for conversation ${conversationId} (${Math.round(timeSinceLastActivity/1000)}s idle), cleaning up...`);
          this.cleanupConversation(conversationId, 'heartbeat_timeout');
        }
      });
    }, this.HEARTBEAT_INTERVAL);
  }

  // Start heartbeat for a specific conversation
  private startConversationHeartbeat(conversationId: string) {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return;

    // Clear any existing heartbeat interval
    if (conversation.heartbeatInterval) {
      clearInterval(conversation.heartbeatInterval);
    }

    // Send ping every 30 seconds
    conversation.heartbeatInterval = setInterval(() => {
      if (conversation.clientWs && conversation.clientWs.readyState === WebSocket.OPEN) {
        this.sendToClient(conversation.clientWs, { type: 'ping', timestamp: Date.now() });
        console.log(`[RealtimeVoice] Sent ping to conversation ${conversationId}`);
      }
    }, this.HEARTBEAT_INTERVAL);

    console.log(`[RealtimeVoice] Started heartbeat for conversation ${conversationId}`);
  }

  // Comprehensive cleanup for a conversation
  private cleanupConversation(conversationId: string, reason: string = 'unknown') {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return;

    console.log('[RealtimeVoice] Cleaning up conversation:', conversationId, 'reason:', reason);

    try {
      // CRITICAL FIX: Send session_closed message to client BEFORE cleanup
      // This prevents client from retrying with stale conversationId
      if (conversation.clientWs && conversation.clientWs.readyState === WebSocket.OPEN) {
        this.sendToClient(conversation.clientWs, {
          type: 'session_closed',
          reason: reason,
          conversationId: conversationId
        });
        console.log('[RealtimeVoice] Sent session_closed notification to client');
      }
      
      // Clear heartbeat interval
      if (conversation.heartbeatInterval) {
        clearInterval(conversation.heartbeatInterval);
        conversation.heartbeatInterval = undefined;
      }

      // Clear reconnection timeout
      if (conversation.reconnectTimeout) {
        clearTimeout(conversation.reconnectTimeout);
        conversation.reconnectTimeout = undefined;
      }

      // Close OpenAI WebSocket
      if (conversation.openaiWs) {
        if (conversation.openaiWs.readyState === WebSocket.OPEN || conversation.openaiWs.readyState === WebSocket.CONNECTING) {
          conversation.openaiWs.close();
        }
        conversation.openaiWs = null;
      }

      // Close client WebSocket if still open (after notification sent)
      if (conversation.clientWs && conversation.clientWs.readyState === WebSocket.OPEN) {
        conversation.clientWs.close();
      }

      // Clean up journey state for this conversation
      journeyService.resetJourney(conversationId).catch(err => {
        console.error('[RealtimeVoice] Error resetting journey:', err);
      });

      // Remove from map
      this.conversations.delete(conversationId);

      // Atomically delete voice conversation if it has 0 messages
      const businessAccId = conversation.businessAccountId;
      storage.deleteConversationIfEmpty(conversationId, businessAccId).then(deleted => {
        if (deleted) {
          console.log('[RealtimeVoice] Deleted empty voice conversation:', conversationId);
        }
      }).catch(err => {
        console.error('[RealtimeVoice] Error cleaning up empty conversation:', err);
      });
      
      console.log('[RealtimeVoice] Conversation cleanup complete:', conversationId);
    } catch (error) {
      console.error('[RealtimeVoice] Cleanup error:', error);
    }
  }

  // Cancel ongoing AI response (for interruptions)
  private cancelResponse(conversation: VoiceConversation) {
    if (conversation.openaiWs && conversation.openaiWs.readyState === WebSocket.OPEN) {
      if (!conversation.isProcessing) {
        console.log('[RealtimeVoice] No active response to cancel, skipping response.cancel');
        return;
      }
      conversation.openaiWs.send(JSON.stringify({
        type: 'response.cancel'
      }));
      conversation.isProcessing = false;
      console.log('[RealtimeVoice] Cancelled ongoing AI response');
    }
  }

  private async connectToOpenAI(conversationId: string, conversation: VoiceConversation) {
    // Using gpt-realtime-mini - the most cost-effective OpenAI Realtime model (82% cheaper)
    const url = 'wss://api.openai.com/v1/realtime?model=gpt-realtime-mini';
    
    console.log('[RealtimeVoice] Connecting to OpenAI Realtime API...');

    const openaiWs = new WebSocket(url, {
      headers: {
        'Authorization': `Bearer ${conversation.openaiApiKey}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    });

    conversation.openaiWs = openaiWs;

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('OpenAI connection timeout'));
      }, 10000);

      let connectionEstablished = false;

      openaiWs.on('open', async () => {
        clearTimeout(timeout);
        console.log('[RealtimeVoice] Connected to OpenAI Realtime API');
        connectionEstablished = true;

        await this.injectTextChatHistory(conversation);

        const systemInstructions = await this.buildSystemInstructions(conversation);
        
        const settings = await storage.getWidgetSettings(conversation.businessAccountId);
        const selectedVoice = settings?.voiceSelection || 'shimmer';
        const businessAccount = await storage.getBusinessAccount(conversation.businessAccountId);
        const appointmentsEnabled = businessAccount?.appointmentsEnabled || false;

        const useElevenLabs = !!conversation.elevenlabsApiKey && !!conversation.elevenlabsVoiceId;
        const openaiVoice = (useElevenLabs || isElevenLabsVoice(selectedVoice)) ? 'shimmer' : selectedVoice;
        if (useElevenLabs) {
          console.log('[RealtimeVoice] ElevenLabs TTS active - voice:', selectedVoice, 'voiceId:', conversation.elevenlabsVoiceId);
        }

        const sessionConfig = {
          type: 'session.update',
          session: {
            instructions: systemInstructions,
            voice: openaiVoice,
            modalities: ['audio', 'text'],
            input_audio_format: 'pcm16',
            output_audio_format: 'pcm16',
            input_audio_transcription: {
              model: 'gpt-4o-mini-transcribe',
              ...(conversation.selectedLanguage && conversation.selectedLanguage !== 'auto' 
                ? { language: this.toTranscriptionLangCode(conversation.selectedLanguage) } 
                : {})
            },
            input_audio_noise_reduction: {
              type: 'far_field'
            },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.8,
              prefix_padding_ms: 300,
              silence_duration_ms: 800,
              create_response: false
            },
            tools: this.convertToRealtimeTools(aiTools),
            tool_choice: 'auto',
            temperature: 1.0,
            max_response_output_tokens: 4096
          }
        };

        openaiWs.send(JSON.stringify(sessionConfig));
        console.log('[RealtimeVoice] Session configured with voice:', selectedVoice);

        resolve();
      });

      openaiWs.on('message', (data: any) => {
        this.handleOpenAIMessage(conversationId, conversation, data);
      });

      openaiWs.on('error', (error) => {
        clearTimeout(timeout);
        console.error('[RealtimeVoice] OpenAI WebSocket error:', error);
        
        // If connection was never established, reject the Promise
        if (!connectionEstablished) {
          reject(error);
        } else {
          // Connection was established but error occurred later - trigger reconnection
          this.handleOpenAIDisconnection(conversationId, 'error');
        }
      });

      openaiWs.on('close', (code, reason) => {
        console.log('[RealtimeVoice] OpenAI WebSocket closed for conversation:', conversationId, 'Code:', code, 'Reason:', reason.toString());
        conversation.openaiWs = null;
        
        // If connection was never established, reject the Promise
        if (!connectionEstablished) {
          reject(new Error(`OpenAI connection closed before establishing: ${code} ${reason.toString()}`));
        } else {
          // Connection was established but closed later - trigger reconnection
          this.handleOpenAIDisconnection(conversationId, 'close');
        }
      });
    });
  }

  // Handle OpenAI disconnection with reconnection logic
  private handleOpenAIDisconnection(conversationId: string, reason: 'error' | 'close') {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      console.log('[RealtimeVoice] Conversation already cleaned up:', conversationId);
      return;
    }

    // If already reconnecting, don't trigger another reconnection
    if (conversation.isReconnecting) {
      console.log('[RealtimeVoice] Already reconnecting, skipping duplicate reconnection attempt');
      return;
    }

    // If client disconnected, clean up instead of reconnecting
    if (conversation.clientWs.readyState !== WebSocket.OPEN) {
      console.log('[RealtimeVoice] Client disconnected, cleaning up instead of reconnecting');
      this.cleanupConversation(conversationId, 'client_disconnected');
      return;
    }

    // If max reconnect attempts reached, cleanup and notify client
    if (conversation.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      console.error('[RealtimeVoice] Max reconnection attempts reached, giving up');
      this.sendError(conversation.clientWs, 'Voice connection lost. Please refresh and try again.');
      this.cleanupConversation(conversationId, 'max_reconnect_attempts');
      return;
    }

    // Calculate exponential backoff delay
    const delay = Math.min(
      this.BASE_RECONNECT_DELAY * Math.pow(2, conversation.reconnectAttempts),
      this.MAX_RECONNECT_DELAY
    );

    console.log(`[RealtimeVoice] OpenAI disconnected (${reason}), reconnecting in ${delay}ms (attempt ${conversation.reconnectAttempts + 1}/${this.MAX_RECONNECT_ATTEMPTS})`);

    // Clear any existing reconnect timeout
    if (conversation.reconnectTimeout) {
      clearTimeout(conversation.reconnectTimeout);
    }

    // Mark as reconnecting
    conversation.isReconnecting = true;
    conversation.reconnectAttempts++;

    // Schedule reconnection with exponential backoff
    conversation.reconnectTimeout = setTimeout(async () => {
      await this.reconnectToOpenAI(conversationId);
    }, delay);
  }

  // Reconnect to OpenAI Realtime API
  private async reconnectToOpenAI(conversationId: string) {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      console.log('[RealtimeVoice] Conversation no longer exists, skipping reconnection');
      return;
    }

    // Check if client is still connected
    if (conversation.clientWs.readyState !== WebSocket.OPEN) {
      console.log('[RealtimeVoice] Client disconnected during reconnection, cleaning up');
      this.cleanupConversation(conversationId, 'client_disconnected_during_reconnect');
      return;
    }

    console.log(`[RealtimeVoice] Attempting to reconnect to OpenAI (attempt ${conversation.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS})`);

    try {
      // Close existing OpenAI WebSocket if still open
      if (conversation.openaiWs && conversation.openaiWs.readyState === WebSocket.OPEN) {
        conversation.openaiWs.close();
        conversation.openaiWs = null;
      }

      // Attempt to reconnect
      await this.connectToOpenAI(conversationId, conversation);
      
      // Success! Reset reconnection state
      console.log('[RealtimeVoice] Successfully reconnected to OpenAI');
      conversation.reconnectAttempts = 0;
      conversation.isReconnecting = false;
      conversation.reconnectTimeout = undefined; // Clear the timeout handle
      
      // Notify client of successful reconnection
      this.sendToClient(conversation.clientWs, {
        type: 'reconnected',
        message: 'Voice connection restored'
      });
      
    } catch (error) {
      console.error('[RealtimeVoice] Reconnection failed:', error);
      
      // Clear the reconnection state before triggering next attempt
      conversation.isReconnecting = false;
      conversation.reconnectTimeout = undefined;
      
      // Trigger another reconnection attempt (will check max attempts)
      this.handleOpenAIDisconnection(conversationId, 'error');
    }
  }

  private detectLanguageFromText(text: string): { language: string; languageName: string } {
    if (!text || text.trim().length === 0) {
      return { language: 'en', languageName: 'English' };
    }

    const devanagariCount = (text.match(/[\u0900-\u097F]/g) || []).length;
    const arabicUrduCount = (text.match(/[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/g) || []).length;
    const tamilCount = (text.match(/[\u0B80-\u0BFF]/g) || []).length;
    const teluguCount = (text.match(/[\u0C00-\u0C7F]/g) || []).length;
    const kannadaCount = (text.match(/[\u0C80-\u0CFF]/g) || []).length;
    const malayalamCount = (text.match(/[\u0D00-\u0D7F]/g) || []).length;
    const bengaliCount = (text.match(/[\u0980-\u09FF]/g) || []).length;
    const gujaratiCount = (text.match(/[\u0A80-\u0AFF]/g) || []).length;
    const gurmukhiCount = (text.match(/[\u0A00-\u0A7F]/g) || []).length;
    const odiaCount = (text.match(/[\u0B00-\u0B7F]/g) || []).length;
    const marathiCount = devanagariCount;

    const scriptCounts: [number, string, string][] = [
      [devanagariCount, 'hi', 'Hindi'],
      [arabicUrduCount, 'hi', 'Hindi'],
      [tamilCount, 'ta', 'Tamil'],
      [teluguCount, 'te', 'Telugu'],
      [kannadaCount, 'kn', 'Kannada'],
      [malayalamCount, 'ml', 'Malayalam'],
      [bengaliCount, 'bn', 'Bengali'],
      [gujaratiCount, 'gu', 'Gujarati'],
      [gurmukhiCount, 'pa', 'Punjabi'],
      [odiaCount, 'or', 'Odia'],
    ];

    const maxScript = scriptCounts.reduce((max, curr) => curr[0] > max[0] ? curr : max, [0, 'en', 'English'] as [number, string, string]);

    if (maxScript[0] > 0) {
      return { language: maxScript[1], languageName: maxScript[2] };
    }

    return { language: 'en', languageName: 'English' };
  }

  private toTranscriptionLangCode(code: string): string {
    const nonStandardMap: Record<string, string> = {
      hinglish: 'hi',
    };
    return nonStandardMap[code] || code;
  }

  private getLanguageNameForCode(code: string): string {
    const map: Record<string, string> = {
      hi: 'Hindi', en: 'English', hinglish: 'Hinglish', ta: 'Tamil', te: 'Telugu',
      kn: 'Kannada', mr: 'Marathi', bn: 'Bengali', gu: 'Gujarati', ml: 'Malayalam',
      pa: 'Punjabi', or: 'Odia', ur: 'Urdu', as: 'Assamese', ne: 'Nepali',
      sa: 'Sanskrit', es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese',
      it: 'Italian', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', ar: 'Arabic',
      ru: 'Russian', th: 'Thai', vi: 'Vietnamese', id: 'Indonesian', ms: 'Malay', tr: 'Turkish',
    };
    return map[code] || 'English';
  }

  private isPrimarilyLatinScript(text: string): boolean {
    let latinCount = 0;
    let nonLatinCount = 0;
    for (const char of text) {
      const code = char.codePointAt(0)!;
      if ((code >= 0x0041 && code <= 0x005A) || (code >= 0x0061 && code <= 0x007A) ||
          (code >= 0x00C0 && code <= 0x024F)) {
        latinCount++;
      } else if (code > 0x024F && !(/\s|\d|[.,!?;:'"()\-–—…\/\\@#$%^&*+=\[\]{}|<>~`]/.test(char))) {
        nonLatinCount++;
      }
    }
    const total = latinCount + nonLatinCount;
    if (total === 0) return true;
    return (latinCount / total) > 0.7;
  }

  private async correctTranscriptScript(
    rawTranscript: string,
    targetLanguage: string,
    conversation: VoiceConversation
  ): Promise<void> {
    try {
      const langName = this.getLanguageNameForCode(targetLanguage);
      
      if (targetLanguage === 'en' || !rawTranscript || rawTranscript.trim().length < 2) {
        return;
      }

      if (this.isPrimarilyLatinScript(rawTranscript)) {
        console.log('[RealtimeVoice] Transcript is primarily Latin script, skipping correction');
        return;
      }

      const openai = new OpenAI({ apiKey: conversation.openaiApiKey });
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are a transcription script corrector. The user's speech was transcribed but may be in the wrong writing system/script. For example, Hindi text might appear in Urdu/Arabic script instead of Devanagari, or in Cyrillic instead of the correct script. Your ONLY job is to convert the text to the correct script for ${langName}. CRITICAL RULES: 1) NEVER translate between languages. If the text is in English or any other language, return it EXACTLY as-is. 2) Only fix the writing system — e.g., convert Arabic/Nastaliq script to Devanagari for Hindi. 3) If the text is already in the correct script, return it as-is. 4) Output only the corrected text. No quotes, no explanations.`
          },
          {
            role: 'user',
            content: rawTranscript
          }
        ],
        max_tokens: 500,
        temperature: 0,
      });

      const corrected = response.choices[0]?.message?.content?.trim();
      
      if (corrected && corrected !== rawTranscript) {
        console.log(`[RealtimeVoice] Transcript corrected: "${rawTranscript}" → "${corrected}"`);
        
        this.sendToClient(conversation.clientWs, {
          type: 'transcript_correction',
          original: rawTranscript,
          corrected: corrected
        });

        if (conversation.conversationId) {
          await this.updateMessageInDB(conversation.conversationId, rawTranscript, corrected);
        }
      } else {
        console.log('[RealtimeVoice] Transcript script already correct, no correction needed');
      }
    } catch (error) {
      console.error('[RealtimeVoice] Transcript correction error:', error);
    }
  }

  private async updateMessageInDB(conversationId: string, originalText: string, correctedText: string): Promise<void> {
    try {
      const { db } = await import('./db');
      const { messages } = await import('../shared/schema');
      const { eq, and, desc } = await import('drizzle-orm');
      
      const recentMessages = await db.select()
        .from(messages)
        .where(and(
          eq(messages.conversationId, conversationId),
          eq(messages.role, 'user')
        ))
        .orderBy(desc(messages.createdAt))
        .limit(5);
      
      const matchingMsg = recentMessages.find(m => m.content === originalText);
      if (matchingMsg) {
        await db.update(messages)
          .set({ content: correctedText })
          .where(eq(messages.id, matchingMsg.id));
        console.log('[RealtimeVoice] Updated message in DB with corrected transcript');
      }
    } catch (error) {
      console.error('[RealtimeVoice] Error updating message in DB:', error);
    }
  }

  private async buildSystemInstructions(conversation: VoiceConversation): Promise<string> {
    const { personality, companyDescription, customInstructions, currencySymbol, currency, businessAccountId, conversationId } = conversation;

    // Determine voice gender from voice selection for proper pronouns
    const settings = await storage.getWidgetSettings(businessAccountId);
    const selectedVoice = (settings?.voiceSelection || 'shimmer').toLowerCase();
    const maleVoices = ['ash', 'ballad', 'echo', 'fable', 'onyx', 'verse'];
    const femaleVoices = ['coral', 'nova', 'sage', 'shimmer'];
    const voiceGender = maleVoices.includes(selectedVoice) ? 'male' : femaleVoices.includes(selectedVoice) ? 'female' : 'neutral';

    let instructions = `You are Chroney, an AI assistant for ${companyDescription || 'a business'}. `;

    if (voiceGender === 'male') {
      instructions += 'You are a MALE assistant. In English use "he/him" if referring to yourself in third person. In languages with grammatical gender, always use masculine forms. ';
    } else if (voiceGender === 'female') {
      instructions += 'You are a FEMALE assistant. In English use "she/her" if referring to yourself in third person. In languages with grammatical gender, always use feminine forms. ';
    }

    const selectedLang = conversation.selectedLanguage;
    const hasExplicitLanguageSelection = selectedLang && selectedLang !== 'auto';

    if (hasExplicitLanguageSelection) {
      const LANGUAGE_NAMES: Record<string, string> = {
        'en': 'English', 'hi': 'Hindi', 'hinglish': 'Hinglish',
        'ta': 'Tamil', 'te': 'Telugu', 'kn': 'Kannada', 'mr': 'Marathi', 'bn': 'Bengali',
        'gu': 'Gujarati', 'ml': 'Malayalam', 'pa': 'Punjabi', 'or': 'Odia', 'ur': 'Urdu',
        'es': 'Spanish', 'fr': 'French', 'de': 'German', 'pt': 'Portuguese', 'it': 'Italian',
        'ja': 'Japanese', 'ko': 'Korean', 'zh': 'Chinese', 'ar': 'Arabic', 'ru': 'Russian',
        'th': 'Thai', 'vi': 'Vietnamese', 'id': 'Indonesian', 'ms': 'Malay', 'tr': 'Turkish'
      };
      const langName = LANGUAGE_NAMES[selectedLang] || selectedLang;

      instructions += `\n\n🚨 CRITICAL RULE #1 - LANGUAGE (OVERRIDES EVERYTHING):\n`;
      instructions += `The user has selected ${langName} from the language dropdown. You MUST respond ONLY in ${langName}.\n`;
      instructions += `Even if the user speaks a different language, ALWAYS respond in ${langName}.\n`;
      instructions += `THIS RULE OVERRIDES ALL CUSTOM BUSINESS INSTRUCTIONS BELOW.\n`;
    } else if (conversation.detectedLanguage) {
      const LANGUAGE_NAMES: Record<string, string> = {
        'en': 'English', 'hi': 'Hindi (Devanagari script)', 'hinglish': 'Hinglish',
        'ta': 'Tamil', 'te': 'Telugu', 'kn': 'Kannada', 'mr': 'Marathi', 'bn': 'Bengali',
        'gu': 'Gujarati', 'ml': 'Malayalam', 'pa': 'Punjabi', 'or': 'Odia', 'ur': 'Hindi (Devanagari script)'
      };
      const detectedLangName = LANGUAGE_NAMES[conversation.detectedLanguage] || 'English';

      instructions += `\n\n🚨 CRITICAL RULE #1 - LANGUAGE (OVERRIDES EVERYTHING):\n`;
      instructions += `The user is speaking in ${detectedLangName}. You MUST respond ONLY in ${detectedLangName}.\n`;
      instructions += `Both your spoken audio AND written text MUST be in ${detectedLangName}.\n`;
      instructions += `THIS RULE OVERRIDES ALL CUSTOM BUSINESS INSTRUCTIONS BELOW.\n`;
    } else {
      instructions += '\n\n🚨 CRITICAL RULE #1 - LANGUAGE MATCHING (OVERRIDES EVERYTHING):\n';
      instructions += 'YOU MUST RESPOND IN THE EXACT SAME LANGUAGE AS THE USER\'S LAST MESSAGE.\n';
      instructions += 'Detect language ONLY from the user\'s latest message. Ignore previous conversation history.\n';
      instructions += 'If the user speaks English → respond 100% in English.\n';
      instructions += 'If the user speaks Hindi → respond 100% in Hindi (Devanagari script).\n';
      instructions += 'If the user code-switches between languages → code-switch the same way.\n';
      instructions += 'Language can change between messages - always match the MOST RECENT input.\n';
      instructions += 'THIS RULE OVERRIDES ALL CUSTOM BUSINESS INSTRUCTIONS BELOW.\n';
    }
    
    // Add personality
    if (personality === 'friendly') {
      instructions += '\nBe warm, conversational, and helpful. ';
    } else if (personality === 'professional') {
      instructions += '\nBe professional, clear, and concise. ';
    } else if (personality === 'casual') {
      instructions += '\nBe casual, fun, and engaging. ';
    }

    // Add custom business instructions (HIGH PRIORITY - but AFTER language matching)
    if (customInstructions && customInstructions.trim()) {
      try {
        // Try to parse as JSON array (new format from Train Chroney page)
        const instructionsArray = JSON.parse(customInstructions);
        if (Array.isArray(instructionsArray) && instructionsArray.length > 0) {
          const formattedInstructions = instructionsArray
            .map((instr: any, index: number) => `${index + 1}. ${instr.text}`)
            .join('\n');
          instructions += `\n\n🎯 CUSTOM BUSINESS INSTRUCTIONS (MUST FOLLOW - but respect language matching above):\nFollow these specific instructions for this business:\n${formattedInstructions}\n`;
        }
      } catch {
        // Fallback to plain text format (legacy)
        instructions += `\n\n🎯 CUSTOM BUSINESS INSTRUCTIONS (MUST FOLLOW - but respect language matching above):\nFollow these specific instructions for this business:\n${customInstructions}\n`;
      }
    }

    // CRITICAL GUARDRAILS
    instructions += '\n\nGUARDRAILS (MUST FOLLOW):\n';
    instructions += '- ONLY answer questions related to this business\'s products, services, pricing, FAQs, and company information\n';
    instructions += '- DECLINE politely if asked about unrelated topics (world events, general knowledge, entertainment, sports, history, science, politics, health advice, financial advice)\n';
    instructions += '- When declining, keep it SHORT (1 sentence), friendly, and redirect to what you CAN help with\n';
    instructions += '- Example decline: "I focus on helping with our products and services. What can I tell you about what we offer?"\n';
    instructions += '- NEVER provide medical, legal, or financial advice\n';
    instructions += '- NEVER expose internal operations or backend processes\n';

    if (conversation.textHistoryInjected) {
      instructions += '\n\nCONVERSATION CONTINUITY:\n';
      instructions += 'The user was chatting with you via text before switching to voice mode. ';
      instructions += 'The previous text messages have been loaded into this conversation. ';
      instructions += 'When the user refers to "the question I asked", "what we discussed", "the previous topic", or similar references, ';
      instructions += 'look at the earlier messages in this conversation to understand the context. ';
      instructions += 'Do NOT call tools to look up information that was already discussed in the text chat — use the conversation history instead.\n';
    }

    // Add voice-specific instructions for emotional, human-like speech
    instructions += '\n\nVOICE MODE GUIDELINES - SPEAK LIKE A REAL HUMAN:\n';
    instructions += '- Speak naturally with genuine emotion and warmth, as if having a real conversation with a friend\n';
    instructions += '- Use natural speech patterns: pauses for thinking ("hmm...", "let me see..."), excitement when appropriate ("oh!", "that\'s great!")\n';
    instructions += '- Express emotions authentically: happiness, enthusiasm, empathy, curiosity - let your voice reflect your feelings\n';
    instructions += '- Include conversational fillers: "you know", "I mean", "actually", "so", "well"\n';
    instructions += '- Take natural breaks in your speech - don\'t rush, speak at a comfortable human pace\n';
    instructions += '- Laugh or chuckle when something is funny or delightful\n';
    instructions += '- Show empathy and understanding when appropriate - adjust your tone to match the situation\n';
    instructions += '- Keep responses concise (2-4 sentences) but make every word count with personality\n';
    instructions += '- Never use emojis or special characters - let your voice convey the emotion instead\n';
    instructions += '- If asked about products, share them enthusiastically like you\'re recommending to a friend\n';
    instructions += '\n\nVOICE INPUT QUALITY RULES:\n';
    instructions += '- Only respond to clear, intentional speech from the user directly speaking into their microphone\n';
    instructions += '- If you detect unclear, fragmented, or mixed speech with background noise, politely ask: "I didn\'t quite catch that. Could you repeat?"\n';
    instructions += '- Never respond to background voices, TV sounds, or distant speech - only direct user input\n';
    instructions += '- If the audio seems to be from your own previous response echoing back, completely ignore it\n';
    instructions += '- Wait for complete, coherent questions before answering - don\'t guess or fill in missing words\n';

    // Add currency information
    if (currency && currencySymbol) {
      instructions += `\n\nCURRENCY SETTINGS:\nAll prices should be referenced in ${currency} (${currencySymbol}). When discussing prices, always use ${currencySymbol} as the currency symbol.`;
    }

    // Load business context (FAQs, products, website analysis, training docs)
    try {
      const businessContext = await this.loadBusinessContext(businessAccountId);
      if (businessContext) {
        instructions += `\n\n${businessContext}`;
      }
    } catch (error) {
      console.error('[RealtimeVoice] Error loading business context:', error);
    }

    // Auto-inject journey conversational guidelines if journey is active
    try {
      const activeJourneyState = await journeyService.getJourneyState(conversationId);
      if (activeJourneyState && !activeJourneyState.completed) {
        const journey = await storage.getJourney(activeJourneyState.journeyId, businessAccountId);
        if (journey && journey.conversationalGuidelines) {
          instructions += `\n\n🎯 JOURNEY-SPECIFIC CONVERSATIONAL GUIDELINES (HIGHEST PRIORITY - MUST FOLLOW):\n${journey.conversationalGuidelines}\n`;
          console.log('[RealtimeVoice] Injected journey conversational guidelines for journey:', journey.name);
        }
      }
    } catch (error) {
      console.error('[RealtimeVoice] Error injecting journey guidelines:', error);
    }

    return instructions;
  }

  private async injectTextChatHistory(conversation: VoiceConversation): Promise<boolean> {
    if (!conversation.textConversationId || !conversation.openaiWs) {
      return false;
    }

    try {
      const textConversation = await storage.getConversation(
        conversation.textConversationId,
        conversation.businessAccountId
      );

      if (!textConversation) {
        console.warn('[RealtimeVoice] Text conversation not found or access denied:', conversation.textConversationId);
        conversation.textConversationId = undefined;
        return false;
      }

      const messages = await storage.getMessagesByConversation(
        conversation.textConversationId,
        conversation.businessAccountId
      );

      if (!messages || messages.length === 0) {
        console.log('[RealtimeVoice] No text chat history to inject');
        return false;
      }

      const recentMessages = messages.slice(-20);

      console.log(`[RealtimeVoice] Injecting ${recentMessages.length} text chat messages into voice session`);

      let injectedCount = 0;
      for (const msg of recentMessages) {
        if (!msg.content || msg.content.trim() === '') continue;

        const item: any = {
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: msg.role === 'user' ? 'user' : 'assistant',
            content: [{
              type: msg.role === 'user' ? 'input_text' : 'text',
              text: msg.content.substring(0, 2000)
            }]
          }
        };

        conversation.openaiWs!.send(JSON.stringify(item));
        injectedCount++;
      }

      console.log(`[RealtimeVoice] Text chat history injected successfully (${injectedCount} messages)`);
      if (injectedCount > 0) {
        conversation.textHistoryInjected = true;
      }
      return injectedCount > 0;
    } catch (error) {
      console.error('[RealtimeVoice] Error injecting text chat history:', error);
      conversation.textConversationId = undefined;
      return false;
    }
  }

  private async loadBusinessContext(businessAccountId: string): Promise<string> {
    let context = '';

    // Load FAQs
    try {
      const faqs = await storage.getAllFaqs(businessAccountId);
      if (faqs.length > 0) {
        context += `KNOWLEDGE BASE (FAQs):\nYou have complete knowledge of the following frequently asked questions. Answer these questions directly from your knowledge without mentioning FAQs:\n\n`;
        faqs.forEach((faq, index) => {
          context += `${index + 1}. Q: ${faq.question}\n   A: ${faq.answer}\n\n`;
        });
        context += `IMPORTANT: When customers ask questions related to the above topics, answer directly and naturally from your knowledge. DO NOT mention that you're checking FAQs - just provide the answer as if you know it by heart.\n\n`;
      }
    } catch (error) {
      console.error('[RealtimeVoice] Error loading FAQs:', error);
    }

    // Load comprehensive product catalog (both Shopify and custom products)
    try {
      const products = await storage.getAllProducts(businessAccountId);
      
      // Get widget settings for currency symbol
      const widgetSettings = await storage.getWidgetSettings(businessAccountId);
      const currencySymbol = widgetSettings?.currency ? 
        (widgetSettings.currency === 'INR' ? '₹' : 
         widgetSettings.currency === 'EUR' ? '€' : 
         widgetSettings.currency === 'GBP' ? '£' : '$') : '$';
      
      if (products.length > 0) {
        context += `PRODUCT CATALOG:\nYou have complete knowledge of all ${products.length} products in the catalog. Use this information to intelligently recommend products based on customer requirements:\n\n`;
        
        products.forEach((product, index) => {
          context += `${index + 1}. ${product.name}`;
          
          // Add price information
          if (product.price) {
            context += ` - ${currencySymbol}${product.price}`;
          }
          
          // Add source information (Shopify or Custom)
          context += ` [Source: ${product.source === 'shopify' ? 'Shopify' : 'Custom'}]`;
          
          // Add full description
          if (product.description) {
            context += `\n   Description: ${product.description}`;
          }
          
          // Add image availability
          if (product.imageUrl) {
            context += `\n   Image: Available`;
          }
          
          context += `\n\n`;
        });
        
        context += `PRODUCT RECOMMENDATION GUIDELINES:\n`;
        context += `- When customers ask about products or their needs, analyze their requirements and suggest the most suitable products from the catalog above\n`;
        context += `- Consider price, description, and customer's specific needs when making recommendations\n`;
        context += `- You can recommend multiple products if they meet different aspects of the customer's requirements\n`;
        context += `- Be enthusiastic and natural when discussing products - you know them by heart\n`;
        context += `- Both Shopify products and custom products are equally valuable - recommend based on fit, not source\n\n`;
      }
    } catch (error) {
      console.error('[RealtimeVoice] Error loading products:', error);
    }

    // Load website analysis (match text chat's full context)
    try {
      const { websiteAnalysisService } = await import("./websiteAnalysisService");
      const websiteContent = await websiteAnalysisService.getAnalyzedContent(businessAccountId);
      if (websiteContent) {
        context += `BUSINESS KNOWLEDGE (from website analysis):\nYou have comprehensive knowledge about this business extracted from their website.\n\n`;
        
        if (websiteContent.businessName) {
          context += `Business Name: ${websiteContent.businessName}\n\n`;
        }
        
        if (websiteContent.businessDescription) {
          context += `About: ${websiteContent.businessDescription}\n\n`;
        }
        
        if (websiteContent.targetAudience) {
          context += `Target Audience: ${websiteContent.targetAudience}\n\n`;
        }
        
        if (websiteContent.mainProducts && websiteContent.mainProducts.length > 0) {
          context += `Main Products:\n${websiteContent.mainProducts.map(p => `- ${p}`).join('\n')}\n\n`;
        }
        
        if (websiteContent.mainServices && websiteContent.mainServices.length > 0) {
          context += `Main Services:\n${websiteContent.mainServices.map(s => `- ${s}`).join('\n')}\n\n`;
        }
        
        if (websiteContent.keyFeatures && websiteContent.keyFeatures.length > 0) {
          context += `Key Features:\n${websiteContent.keyFeatures.map(f => `- ${f}`).join('\n')}\n\n`;
        }
        
        if (websiteContent.uniqueSellingPoints && websiteContent.uniqueSellingPoints.length > 0) {
          context += `Unique Selling Points:\n${websiteContent.uniqueSellingPoints.map(u => `- ${u}`).join('\n')}\n\n`;
        }
        
        if (websiteContent.contactInfo && (websiteContent.contactInfo.email || websiteContent.contactInfo.phone || websiteContent.contactInfo.address)) {
          context += `Contact Information:\n`;
          if (websiteContent.contactInfo.email) context += `- Email: ${websiteContent.contactInfo.email}\n`;
          if (websiteContent.contactInfo.phone) context += `- Phone: ${websiteContent.contactInfo.phone}\n`;
          if (websiteContent.contactInfo.address) context += `- Address: ${websiteContent.contactInfo.address}\n`;
          context += '\n';
        }
        
        if (websiteContent.businessHours) {
          context += `Business Hours: ${websiteContent.businessHours}\n\n`;
        }
        
        if (websiteContent.pricingInfo) {
          context += `Pricing: ${websiteContent.pricingInfo}\n\n`;
        }
        
        if (websiteContent.additionalInfo) {
          context += `Additional Information: ${websiteContent.additionalInfo}\n\n`;
        }
        
        context += `IMPORTANT: Use this website knowledge to provide accurate, context-aware responses about the business. Answer naturally without mentioning that you analyzed their website.\n\n`;
      }
    } catch (error) {
      console.error('[RealtimeVoice] Error loading website analysis:', error);
    }

    // Load analyzed pages (limit to avoid token overflow)
    try {
      const analyzedPages = await storage.getAnalyzedPages(businessAccountId);
      if (analyzedPages && analyzedPages.length > 0) {
        const validPages = analyzedPages.filter(page => 
          page.extractedContent && 
          page.extractedContent.trim() !== '' && 
          page.extractedContent !== 'No relevant business information found on this page.'
        );
        
        if (validPages.length > 0) {
          context += `DETAILED WEBSITE CONTENT:\n`;
          // Limit to first 3 pages to avoid token overflow in voice mode
          const pagesToLoad = validPages.slice(0, 3);
          for (const page of pagesToLoad) {
            try {
              let pageName = 'Page';
              try {
                const url = new URL(page.pageUrl);
                const pathParts = url.pathname.split('/').filter(Boolean);
                pageName = pathParts[pathParts.length - 1] || 'Homepage';
              } catch {
                const pathParts = page.pageUrl.split('/').filter(Boolean);
                pageName = pathParts[pathParts.length - 1] || 'Homepage';
              }
              context += `--- ${pageName.toUpperCase()} ---\n${page.extractedContent}\n\n`;
            } catch (error) {
              console.error('[RealtimeVoice] Error processing page:', error);
            }
          }
        }
      }
    } catch (error) {
      console.error('[RealtimeVoice] Error loading analyzed pages:', error);
    }

    // Load training documents
    try {
      const trainingDocs = await storage.getTrainingDocuments(businessAccountId);
      const completedDocs = trainingDocs.filter(doc => doc.uploadStatus === 'completed');
      if (completedDocs.length > 0) {
        context += `TRAINING DOCUMENTS KNOWLEDGE:\n`;
        for (const doc of completedDocs) {
          if (doc.summary || doc.keyPoints) {
            context += `--- ${doc.originalFilename} ---\n`;
            if (doc.summary) {
              context += `Summary: ${doc.summary}\n`;
            }
            if (doc.keyPoints) {
              try {
                const keyPoints = JSON.parse(doc.keyPoints);
                if (Array.isArray(keyPoints) && keyPoints.length > 0) {
                  context += `Key Points:\n`;
                  keyPoints.forEach((point: string, index: number) => {
                    context += `${index + 1}. ${point}\n`;
                  });
                }
              } catch (error) {
                console.error('[RealtimeVoice] Error parsing key points:', error);
              }
            }
            context += `\n`;
          }
        }
      }
    } catch (error) {
      console.error('[RealtimeVoice] Error loading training documents:', error);
    }

    return context;
  }

  private async handleOpenAIMessage(conversationId: string, conversation: VoiceConversation, data: any) {
    try {
      const event = JSON.parse(data.toString());
      console.log('[RealtimeVoice] OpenAI event:', event.type);

      switch (event.type) {
        case 'session.created':
          console.log('[RealtimeVoice] Session created:', event.session.id);
          conversation.sessionId = event.session.id;
          break;

        case 'session.updated':
          console.log('[RealtimeVoice] Session updated');
          break;

        case 'input_audio_buffer.speech_started':
          console.log('[RealtimeVoice] User started speaking');
          this.touchActivity(conversation);
          
          // Cancel ongoing AI response if one is active (isProcessing check inside cancelResponse).
          // We must NOT send response.cancel when no response is active — doing so
          // causes OpenAI to return an error that corrupts the VAD state machine,
          // preventing speech_stopped from ever firing and leaving the session stuck.
          this.cancelResponse(conversation);
          
          this.sendToClient(conversation.clientWs, { type: 'speech_started' });
          break;

        case 'input_audio_buffer.speech_stopped':
          console.log('[RealtimeVoice] User stopped speaking');
          break;

        case 'input_audio_buffer.committed':
          console.log('[RealtimeVoice] Audio buffer committed');
          this.sendToClient(conversation.clientWs, { 
            type: 'transcript',
            text: '',
            isFinal: false
          });
          break;

        case 'conversation.item.input_audio_transcription.completed':
          // User's speech transcribed
          const userTranscript = event.transcript;
          console.log('[RealtimeVoice] User transcript:', userTranscript);
          
          // Save user transcript to conversation
          conversation.currentUserTranscript = userTranscript;
          
          // Save to database and conversation memory
          if (conversation.conversationId && userTranscript) {
            await this.saveMessageToDB(conversation.conversationId, 'user', userTranscript);
            conversationMemory.storeMessage(conversation.userId, 'user', userTranscript);
            console.log('[RealtimeVoice] Saved user message to DB');
          }
          
          this.sendToClient(conversation.clientWs, {
            type: 'transcript',
            text: userTranscript,
            isFinal: true
          });
          
          // GPT TRANSCRIPT CORRECTION: Run in background (non-blocking)
          // Always detect the language of THIS specific transcript, not the previously detected language.
          // This prevents English text from being "corrected" (translated) into Hindi when the user
          // switches languages mid-conversation.
          const thisTranscriptLang = this.detectLanguageFromText(userTranscript.trim());
          if (thisTranscriptLang.language !== 'en') {
            const correctionLang = conversation.selectedLanguage && conversation.selectedLanguage !== 'auto'
              ? conversation.selectedLanguage
              : thisTranscriptLang.language;
            this.correctTranscriptScript(userTranscript, correctionLang, conversation).catch(() => {});
          }
          
          // CRITICAL: Filter out very short/empty transcripts (likely background noise)
          // Only process transcripts with at least 2 meaningful characters
          const trimmedTranscript = userTranscript.trim();
          if (trimmedTranscript.length < 2) {
            console.log('[RealtimeVoice] Ignoring short/empty transcript (likely noise):', userTranscript);
            break; // Skip processing this noise
          }
          
          // AUTO LANGUAGE DETECTION: Detect language from transcribed text and update session
          if (!conversation.selectedLanguage || conversation.selectedLanguage === 'auto') {
            const detected = this.detectLanguageFromText(trimmedTranscript);
            if (detected.language !== conversation.detectedLanguage) {
              conversation.detectedLanguage = detected.language;
              console.log(`[RealtimeVoice] Language detected from transcript: ${detected.languageName} (${detected.language})`);
              
              // Rebuild instructions with detected language and send session.update
              // Also update input_audio_transcription with language hint for correct script
              const updatedInstructions = await this.buildSystemInstructions(conversation);
              if (conversation.openaiWs && conversation.openaiWs.readyState === WebSocket.OPEN) {
                conversation.openaiWs.send(JSON.stringify({
                  type: 'session.update',
                  session: {
                    instructions: updatedInstructions,
                    input_audio_transcription: {
                      model: 'gpt-4o-mini-transcribe',
                      language: this.toTranscriptionLangCode(detected.language)
                    }
                  }
                }));
                console.log(`[RealtimeVoice] Session updated with detected language: ${detected.languageName} (transcription + instructions)`);
              }
            }
          }
          
          // Check if a journey should be activated or is already active
          // CRITICAL: Only process journey if explicitly triggered or already in progress for THIS conversation
          let journeyResult: any = null;
          if (conversation.conversationId && conversation.openaiWs && conversation.openaiWs.readyState === WebSocket.OPEN) {
            journeyResult = await journeyOrchestrator.processUserMessage(
              conversation.conversationId,
              conversation.userId,
              conversation.businessAccountId,
              userTranscript
            );
            
            // CRITICAL: Only inject journey questions if:
            // 1. Journey was just triggered by keyword (wasTriggeredByKeyword === true), OR
            // 2. Journey is active for THIS specific conversation (not a stale journey from another session)
            // This prevents false triggers from old journey sessions in different conversations
            if (journeyResult.journeyResponse && !journeyResult.shouldContinueNormalFlow) {
              const isJourneyForThisConversation = journeyService.isJourneyForConversation(
                conversation.conversationId
              );
              
              if (!journeyResult.wasTriggeredByKeyword && !isJourneyForThisConversation) {
                console.log('[RealtimeVoice] Ignoring stale journey from different conversation - not injecting question');
                // Fall through to normal OpenAI response (don't inject journey question)
              } else {
                console.log('[RealtimeVoice] Journey active for THIS conversation - forcing AI to ask journey question:', journeyResult.journeyResponse);
              
              // SMART INTERRUPTION: Cancel any ongoing response BEFORE injecting journey prompts
              // This prevents the AI from continuing its previous response before the journey question
              if (conversation.isProcessing) {
                console.log('[RealtimeVoice] 🎯 Smart interruption: Cancelling active response before journey question');
                this.cancelResponse(conversation);
                conversation.isProcessing = false;
                
                // Add small delay to allow cancellation to complete
                await new Promise(resolve => setTimeout(resolve, 100));
              }
              
              // CRITICAL FIX BUG 4: Track pending journey step ID (will be added to Map when response.created arrives)
              if (journeyResult.journeyStepId) {
                conversation.pendingJourneyStepId = journeyResult.journeyStepId;
                console.log('[RealtimeVoice] Set pending journey stepId:', journeyResult.journeyStepId, 'for next response.created event');
              } else {
                console.warn('[RealtimeVoice] Journey result missing stepId - cannot track properly!');
              }
              
              // Create a strong system-level instruction that the AI MUST follow
              // Use the SAME strong rephrasing instruction as text chat mode for consistency
              const journeyInstruction = {
                type: 'conversation.item.create',
                item: {
                  type: 'message',
                  role: 'system',
                  content: [
                    {
                      type: 'input_text',
                      text: `═══════════════════════════════════════════════════════════════
CRITICAL JOURNEY INSTRUCTION - HIGHEST PRIORITY - READ CAREFULLY
═══════════════════════════════════════════════════════════════

You are currently in a GUIDED CONVERSATION FLOW. This overrides your normal conversational behavior.

YOUR ONLY TASK RIGHT NOW:
Ask the user this question: "${journeyResult.journeyResponse}"

STRICT REQUIREMENTS:
1. ✓ Rephrase the question naturally to sound warm, friendly, and conversational
2. ✓ Keep it concise - ONLY ask this one question
3. ✗ Do NOT add any other information, explanations, or suggestions
4. ✗ Do NOT call any tools or functions
5. ✗ Do NOT provide product recommendations or capture leads

Remember: You're in a structured flow. Just ask the question naturally, then wait for their answer.
═══════════════════════════════════════════════════════════════`
                    }
                  ]
                }
              };
              
              conversation.openaiWs.send(JSON.stringify(journeyInstruction));
              
              // Trigger response generation - AI will ask the journey question
              const responseCreate = {
                type: 'response.create',
                response: {
                  modalities: ['text', 'audio'],
                  instructions: `You MUST rephrase this question naturally and conversationally: "${journeyResult.journeyResponse}". Make it sound warm and friendly, but keep the same intent. Do NOT add any extra information - ONLY ask the rephrased question.`
                }
              };
              conversation.openaiWs.send(JSON.stringify(responseCreate));
              
              console.log('[RealtimeVoice] Sent FORCED journey question to OpenAI');
              
              // Clear the keyword flag if this was triggered by keyword
              if (journeyResult.wasTriggeredByKeyword) {
                await journeyService.clearKeywordTriggerFlag(conversation.conversationId);
              }
              }
            } else {
              // No active journey - send normal response
              // SMART INTERRUPTION: Check if there's already an active response
              if (conversation.isProcessing) {
                console.log('[RealtimeVoice] 🎯 Smart interruption: Cancelling active response before creating new one');
                this.cancelResponse(conversation);
                conversation.isProcessing = false;
                
                // Add small delay to allow cancellation to complete
                await new Promise(resolve => setTimeout(resolve, 100));
              }
              
              // No journey active - create normal response
              console.log('[RealtimeVoice] Creating normal OpenAI response (no active journey)');
              const responseCreate = {
                type: 'response.create'
              };
              conversation.openaiWs.send(JSON.stringify(responseCreate));
            }
          } else {
            // CRITICAL FIX: If journey check couldn't be performed (conversationId missing or WebSocket not ready),
            // we still need to send a response! Otherwise AI will be silent.
            // SMART INTERRUPTION: Check if there's already an active response
            if (conversation.isProcessing) {
              console.log('[RealtimeVoice] 🎯 Smart interruption: Cancelling active response before creating new one');
              this.cancelResponse(conversation);
              conversation.isProcessing = false;
              
              // Add small delay to allow cancellation to complete
              await new Promise(resolve => setTimeout(resolve, 100));
            }
            
            // Send normal response when journey check couldn't be performed
            console.log('[RealtimeVoice] Creating normal OpenAI response (journey check skipped)');
            const responseCreate = {
              type: 'response.create'
            };
            conversation.openaiWs.send(JSON.stringify(responseCreate));
          }
          break;

        case 'response.created':
          console.log('[RealtimeVoice] Response created, id:', event.response?.id);
          conversation.isProcessing = true;
          conversation.currentAITranscript = '';
          conversation.openaiAudioFallbackBuffer = [];
          // Track current response ID
          conversation.currentResponseId = event.response?.id;
          
          // CRITICAL FIX BUG 4: If we have a pending journey step ID, add it to the Map keyed by stepId
          if (conversation.pendingJourneyStepId && conversation.currentResponseId) {
            // We need the original question text for logging - get it from journeyResult
            const stepId = conversation.pendingJourneyStepId;
            conversation.journeyResponseTracking.set(stepId, {
              original: '', // Will be set in response.done when we have the full transcript
              responseId: conversation.currentResponseId,
              timestamp: Date.now()
            });
            console.log('[RealtimeVoice] Tracked journey by STEP ID:', stepId, 'responseId:', conversation.currentResponseId);
            conversation.pendingJourneyStepId = undefined; // Clear pending
          }
          break;

        case 'response.output_item.added':
          console.log('[RealtimeVoice] Output item added');
          break;

        case 'response.content_part.added':
          console.log('[RealtimeVoice] Content part added');
          break;

        case 'response.audio_transcript.delta':
          // AI's speech transcript chunk
          const transcriptDelta = event.delta;
          console.log('[RealtimeVoice] AI transcript delta:', transcriptDelta);
          
          // Accumulate AI transcript
          conversation.currentAITranscript = (conversation.currentAITranscript || '') + transcriptDelta;
          
          this.sendToClient(conversation.clientWs, {
            type: 'ai_chunk',
            text: transcriptDelta
          });
          break;

        case 'response.audio.delta':
          this.touchActivity(conversation);
          const audioDelta = event.delta;
          const audioBuffer = Buffer.from(audioDelta, 'base64');
          
          if (conversation.elevenlabsApiKey && conversation.elevenlabsVoiceId) {
            if (!conversation.openaiAudioFallbackBuffer) {
              conversation.openaiAudioFallbackBuffer = [];
            }
            conversation.openaiAudioFallbackBuffer.push(audioBuffer);
            break;
          }
          
          if (conversation.clientWs.readyState === WebSocket.OPEN) {
            conversation.clientWs.send(audioBuffer);
          }
          break;

        case 'response.audio_transcript.done':
          console.log('[RealtimeVoice] AI transcript complete');
          if (conversation.elevenlabsApiKey && conversation.elevenlabsVoiceId && conversation.currentAITranscript) {
            await this.synthesizeWithElevenLabs(conversation, conversation.currentAITranscript);
          }
          conversation.openaiAudioFallbackBuffer = [];
          break;

        case 'response.audio.done':
          console.log('[RealtimeVoice] AI audio complete');
          break;

        case 'response.function_call_arguments.done':
          // AI wants to call a tool (lead capture, appointments, etc.)
          await this.handleToolCall(event, conversation);
          break;

        case 'response.done':
          console.log('[RealtimeVoice] Response complete, id:', conversation.currentResponseId);
          conversation.isProcessing = false;
          
          // Save complete AI response to database and conversation memory
          if (conversation.conversationId && conversation.currentAITranscript) {
            await this.saveMessageToDB(conversation.conversationId, 'assistant', conversation.currentAITranscript);
            conversationMemory.storeMessage(conversation.userId, 'assistant', conversation.currentAITranscript);
            console.log('[RealtimeVoice] Saved AI message to DB:', conversation.currentAITranscript.substring(0, 50) + '...');
            
            // CRITICAL FIX BUG 4: Check Map for journey response tracking by stepId
            // This prevents race conditions when multiple journey prompts are triggered rapidly
            // Find stepId by matching responseId
            let foundStepId: string | null = null;
            conversation.journeyResponseTracking.forEach((journeyData, stepId) => {
              if (journeyData.responseId === conversation.currentResponseId) {
                foundStepId = stepId;
              }
            });
            
            if (foundStepId) {
              const rephrasedQuestion = conversation.currentAITranscript.trim();
              console.log('[RealtimeVoice] ✅ Journey question persisted to chat history (stepId:', foundStepId, ')');
              console.log('[RealtimeVoice]    OpenAI responseId:', conversation.currentResponseId);
              console.log('[RealtimeVoice]    AI-rephrased:', rephrasedQuestion);
              console.log('[RealtimeVoice]    This ensures analytics/chat history show refined text instead of raw template');
              
              // Clear this specific journey step from Map (per-step cleanup)
              conversation.journeyResponseTracking.delete(foundStepId);
              console.log('[RealtimeVoice] Cleared journey tracking for stepId:', foundStepId);
            }
          }
          
          this.sendToClient(conversation.clientWs, { type: 'ai_done' });
          break;

        case 'rate_limits.updated':
          // Rate limit info - can be logged if needed
          break;

        case 'error':
          // CRITICAL FIX: Ignore harmless race condition where response finishes before cancellation
          // This happens when AI completes speaking just as user starts interrupting
          if (event.error?.code === 'response_cancel_not_active') {
            console.log('[RealtimeVoice] ℹ️  Response already completed before cancellation (harmless)');
            break; // Don't send to client - this is not an actual error
          }
          
          console.error('[RealtimeVoice] OpenAI error:', event.error);
          this.sendError(conversation.clientWs, event.error.message || 'Voice processing error');
          break;

        default:
          // Log unknown events for debugging
          console.log('[RealtimeVoice] Unknown event type:', event.type);
      }
    } catch (error) {
      console.error('[RealtimeVoice] Error handling OpenAI message:', error);
    }
  }

  // Helper method to save messages to database
  private async saveMessageToDB(conversationId: string, role: 'user' | 'assistant', content: string): Promise<void> {
    try {
      await storage.createMessage({
        conversationId,
        role,
        content
      });
      
      // Update conversation timestamp
      await storage.updateConversationTimestamp(conversationId);
    } catch (error) {
      console.error('[RealtimeVoice] Error saving message to DB:', error);
    }
  }

  // Convert aiTools to OpenAI Realtime API format
  private convertToRealtimeTools(tools: any[]): any[] {
    return tools.map(tool => ({
      type: 'function',
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters
    }));
  }

  // Handle tool calls from OpenAI Realtime API (lead capture, appointments, etc.)
  private async handleToolCall(event: any, conversation: VoiceConversation) {
    const { call_id, name, arguments: argsString } = event;
    
    console.log('[RealtimeVoice] Tool call:', name, argsString);

    try {
      const args = JSON.parse(argsString);
      
      if (!conversation.conversationId) {
        throw new Error('No conversation ID available');
      }

      // Check if appointments are enabled for this business
      const businessAccount = await storage.getBusinessAccount(conversation.businessAccountId);
      const appointmentsEnabled = businessAccount?.appointmentsEnabled === 'true';

      // Execute the tool using ToolExecutionService
      const result = await ToolExecutionService.executeTool(
        name,
        args,
        {
          businessAccountId: conversation.businessAccountId,
          userId: conversation.userId,
          conversationId: conversation.conversationId,
          userMessage: conversation.currentUserTranscript
        },
        conversation.currentUserTranscript,
        appointmentsEnabled
      );

      console.log('[RealtimeVoice] Tool execution result:', result);

      // Send tool result back to OpenAI
      const toolOutput = {
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: call_id,
          output: JSON.stringify(result)
        }
      };

      if (conversation.openaiWs && conversation.openaiWs.readyState === WebSocket.OPEN) {
        conversation.openaiWs.send(JSON.stringify(toolOutput));
        
        // Trigger AI to continue with the tool result
        const responseCreate = {
          type: 'response.create'
        };
        conversation.openaiWs.send(JSON.stringify(responseCreate));
        
        console.log('[RealtimeVoice] Sent tool result back to AI');
      }
    } catch (error) {
      console.error('[RealtimeVoice] Error handling tool call:', error);
      
      // Send error back to OpenAI
      const errorOutput = {
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: event.call_id,
          output: JSON.stringify({ success: false, error: 'Tool execution failed' })
        }
      };
      
      if (conversation.openaiWs && conversation.openaiWs.readyState === WebSocket.OPEN) {
        conversation.openaiWs.send(JSON.stringify(errorOutput));
      }
    }
  }

  private setupClientHandlers(conversationId: string, conversation: VoiceConversation) {
    const { clientWs, openaiWs } = conversation;

    clientWs.on('message', async (data: any, isBinary: boolean) => {
      this.touchActivity(conversation);
      
      if (isBinary) {
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
          const buf = data instanceof Buffer ? data : Buffer.from(data);
          
          if (buf.length === 0 || buf.length < 100) {
            return;
          }
          
          if (buf.length % 2 !== 0) {
            return;
          }
          
          const base64Audio = buf.toString('base64');
          openaiWs.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: base64Audio
          }));
        }
      } else {
        try {
          const message = JSON.parse(data.toString());
          await this.handleClientMessage(conversationId, conversation, message);
        } catch (error) {
          console.error('[RealtimeVoice] Error parsing client message:', error);
        }
      }
    });

    clientWs.on('close', () => {
      // CRITICAL FIX BUG 1: Check if this socket was superseded by reconnection
      // If superseded, skip cleanup - the conversation is being reconnected with a new socket
      if ((clientWs as any)._superseded) {
        console.log('[RealtimeVoice] Superseded socket closed, skipping cleanup (reconnection in progress)');
        return; // DON'T cleanup if superseded
      }
      
      console.log('[RealtimeVoice] Client disconnected for conversation:', conversationId);
      // Cleanup entire conversation when client disconnects
      this.cleanupConversation(conversationId, 'client_disconnected');
    });

    clientWs.on('error', (error) => {
      console.error('[RealtimeVoice] Client WebSocket error:', error);
      this.cleanupConversation(conversationId, 'client_error');
    });
  }

  private async handleClientMessage(
    conversationId: string,
    conversation: VoiceConversation,
    message: any
  ) {
    const { openaiWs } = conversation;

    console.log('[RealtimeVoice] Client message:', message.type);

    switch (message.type) {
      case 'interrupt':
        // User interrupted AI - cancel current response using helper
        console.log('[RealtimeVoice] User interrupted AI');
        this.cancelResponse(conversation);
        
        // Send acknowledgment to client
        this.sendToClient(conversation.clientWs, { type: 'interrupt_ack' });
        break;

      case 'pong':
        // Client responded to ping - update heartbeat timestamp
        conversation.lastHeartbeat = Date.now();
        console.log('[RealtimeVoice] Received pong from conversation:', conversationId);
        break;

      case 'keepalive':
        break;

      default:
        console.log('[RealtimeVoice] Unknown client message type:', message.type);
    }
  }

  private sendToClient(ws: WebSocket, message: any) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  private sendError(ws: WebSocket, message: string) {
    this.sendToClient(ws, { type: 'error', message });
  }

  private async synthesizeWithElevenLabs(conversation: VoiceConversation, text: string): Promise<void> {
    if (!conversation.elevenlabsApiKey || !conversation.elevenlabsVoiceId) return;

    try {
      console.log('[RealtimeVoice] Streaming ElevenLabs TTS, text length:', text.length);

      let totalBytes = 0;
      await synthesizeSpeechStreaming(
        {
          apiKey: conversation.elevenlabsApiKey,
          voiceId: conversation.elevenlabsVoiceId,
          text,
          outputFormat: 'pcm_24000',
        },
        (chunk: Buffer) => {
          if (conversation.clientWs.readyState === WebSocket.OPEN) {
            conversation.clientWs.send(chunk);
            totalBytes += chunk.length;
          }
        }
      );

      console.log('[RealtimeVoice] ElevenLabs stream complete, bytes:', totalBytes);
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error('[RealtimeVoice] ElevenLabs TTS failed, sending OpenAI fallback audio:', errMsg);

      const fallbackChunks = conversation.openaiAudioFallbackBuffer || [];
      if (fallbackChunks.length > 0) {
        for (const chunk of fallbackChunks) {
          if (conversation.clientWs.readyState === WebSocket.OPEN) {
            conversation.clientWs.send(chunk);
          }
        }
        console.log('[RealtimeVoice] Sent OpenAI fallback audio, chunks:', fallbackChunks.length);
      }
    }
  }
}

export const realtimeVoiceService = new RealtimeVoiceService();
