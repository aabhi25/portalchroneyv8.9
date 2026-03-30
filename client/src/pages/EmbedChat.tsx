import { Sparkles, Zap, Send, Loader2, X, Mic, ChevronDown, Camera, ImageIcon, MoreVertical, MessageSquarePlus, History, ChevronLeft, GitCompare, Briefcase } from "lucide-react";
import { useState, useEffect, useRef, lazy, Suspense } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { ProductCard } from "@/components/ProductCard";
import { ConversationStarters } from "@/components/ConversationStarters";
import { ChatImageCropOverlay } from "@/components/ChatImageCropOverlay";
import { TryOnOverlay } from "@/components/TryOnOverlay";
import { useUrgencyOffer } from "@/hooks/useUrgencyOffer";
import { QuickBrowseButtons } from "@/components/QuickBrowseButtons";
import { ResumeUploadProgress } from "@/components/ResumeUploadProgress";
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Lazy-loaded components for optional features (reduces initial bundle)
const VoiceMode = lazy(() => import("@/components/VoiceMode").then(m => ({ default: m.VoiceMode })));
const InlineVoiceMode = lazy(() => import("@/components/InlineVoiceMode").then(m => ({ default: m.InlineVoiceMode })));
const AppointmentCalendar = lazy(() => import("@/components/AppointmentCalendar").then(m => ({ default: m.AppointmentCalendar })));
const FormStep = lazy(() => import("@/components/FormStep").then(m => ({ default: m.FormStep })));
const ProductCarousel = lazy(() => import("@/components/ProductCarousel").then(m => ({ default: m.ProductCarousel })));
const ProductComparisonView = lazy(() => import("@/components/ProductComparisonView").then(m => ({ default: m.ProductComparisonView })));
const ChatMenuNavigation = lazy(() => import("@/components/ChatMenuNavigation").then(m => ({ default: m.ChatMenuNavigation })));
const JobCarousel = lazy(() => import("@/components/JobCarousel").then(m => ({ default: m.JobCarousel })));

// Loading fallback for lazy components
const LazyLoadingFallback = () => (
  <div className="flex items-center justify-center p-4">
    <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
  </div>
);

// Animated typing indicator with rotating messages
const TYPING_MESSAGES = [
  "Thinking...",
  "Finding the best answer...",
  "Almost there...",
];

const TypingIndicator = () => {
  const [messageIndex, setMessageIndex] = useState(0);
  const [isVisible, setIsVisible] = useState(true);

  useEffect(() => {
    const interval = setInterval(() => {
      setIsVisible(false);
      setTimeout(() => {
        setMessageIndex((prev) => (prev + 1) % TYPING_MESSAGES.length);
        setIsVisible(true);
      }, 200);
    }, 2500);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-1">
        <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></div>
        <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
        <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
      </div>
      <span 
        className={`text-sm text-gray-500 italic transition-opacity duration-200 ${isVisible ? 'opacity-100' : 'opacity-0'}`}
      >
        {TYPING_MESSAGES[messageIndex]}
      </span>
    </div>
  );
};

// Language configuration with names in their native script (50+ languages)
const LANGUAGE_CONFIG: Record<string, { name: string; nativeName: string; shortLabel: string }> = {
  auto: { name: 'Auto-detect', nativeName: 'Auto', shortLabel: 'Auto' },
  en: { name: 'English', nativeName: 'English', shortLabel: 'Eng' },
  hi: { name: 'Hindi', nativeName: 'हिंदी', shortLabel: 'Hind' },
  hinglish: { name: 'Hinglish', nativeName: 'Hinglish', shortLabel: 'Hing' },
  kn: { name: 'Kannada', nativeName: 'ಕನ್ನಡ', shortLabel: 'Kann' },
  ta: { name: 'Tamil', nativeName: 'தமிழ்', shortLabel: 'Tam' },
  mr: { name: 'Marathi', nativeName: 'मराठी', shortLabel: 'Mar' },
  te: { name: 'Telugu', nativeName: 'తెలుగు', shortLabel: 'Tel' },
  bn: { name: 'Bengali', nativeName: 'বাংলা', shortLabel: 'Beng' },
  gu: { name: 'Gujarati', nativeName: 'ગુજરાતી', shortLabel: 'Guj' },
  ml: { name: 'Malayalam', nativeName: 'മലയാളം', shortLabel: 'Mal' },
  pa: { name: 'Punjabi', nativeName: 'ਪੰਜਾਬੀ', shortLabel: 'Punj' },
  ur: { name: 'Urdu', nativeName: 'اردو', shortLabel: 'Urdu' },
  or: { name: 'Odia', nativeName: 'ଓଡ଼ିଆ', shortLabel: 'Odia' },
  as: { name: 'Assamese', nativeName: 'অসমীয়া', shortLabel: 'Asm' },
  ne: { name: 'Nepali', nativeName: 'नेपाली', shortLabel: 'Nep' },
  es: { name: 'Spanish', nativeName: 'Español', shortLabel: 'Esp' },
  fr: { name: 'French', nativeName: 'Français', shortLabel: 'Fra' },
  de: { name: 'German', nativeName: 'Deutsch', shortLabel: 'Deu' },
  pt: { name: 'Portuguese', nativeName: 'Português', shortLabel: 'Port' },
  it: { name: 'Italian', nativeName: 'Italiano', shortLabel: 'Ita' },
  ar: { name: 'Arabic', nativeName: 'العربية', shortLabel: 'Arab' },
  zh: { name: 'Chinese', nativeName: '中文', shortLabel: '中文' },
  ja: { name: 'Japanese', nativeName: '日本語', shortLabel: '日本' },
  ko: { name: 'Korean', nativeName: '한국어', shortLabel: '한국' },
  ru: { name: 'Russian', nativeName: 'Русский', shortLabel: 'Рус' },
  th: { name: 'Thai', nativeName: 'ไทย', shortLabel: 'ไทย' },
  vi: { name: 'Vietnamese', nativeName: 'Tiếng Việt', shortLabel: 'Việt' },
  id: { name: 'Indonesian', nativeName: 'Bahasa Indonesia', shortLabel: 'Indo' },
  ms: { name: 'Malay', nativeName: 'Bahasa Melayu', shortLabel: 'Mly' },
  tr: { name: 'Turkish', nativeName: 'Türkçe', shortLabel: 'Türk' },
};

interface ProductPagination {
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset: number | null;
  showing: number;
}

interface AppointmentSlotsData {
  slots: Record<string, string[]>;
  durationMinutes: number;
}

interface FormStepData {
  stepId: string;
  questionText: string;
  questionType: string;
  isRequired: boolean;
  options?: string[];
  placeholder?: string;
  stepType?: string;
  completionButtonText?: string;
  journeyId?: string;
  conversationId?: string;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  products?: any[];
  productPagination?: ProductPagination;
  productSearchQuery?: string;
  imageUrl?: string;
  matchedProducts?: any[];
  imageDescription?: string;
  appointmentSlots?: AppointmentSlotsData;
  formStep?: FormStepData;
  tryOnResult?: string;
  jobs?: any[];
  applicantId?: string | null;
}

interface WidgetSettings {
  id: string;
  businessAccountId: string;
  chatColor: string;
  chatColorEnd: string;
  widgetHeaderText: string;
  welcomeMessageType: string;
  welcomeMessage: string;
  buttonStyle: string;
  buttonAnimation: string;
  personality: string;
  currency: string;
  voiceModeEnabled?: boolean;
  visualSearchEnabled?: boolean;
  voiceModeStyle?: string;
  chatMode?: string;
  avatarType?: string;
  avatarUrl?: string;
  conversationStarters?: string;
  conversationStartersEnabled?: string;
  showStartersOnPill?: string;
  inactivityNudgeEnabled?: string;
  inactivityNudgeDelay?: string;
  inactivityNudgeMessage?: string;
  inactivityNudgeMessages?: { message: string; delay: number }[];
  smartNudgeEnabled?: string;
  proactiveNudgeEnabled?: string;
  proactiveNudgeDelay?: string;
  proactiveNudgeMessage?: string;
  languageSelectorEnabled?: string;
  availableLanguages?: string;
  productCarouselEnabled?: string;
  productCarouselTitle?: string;
  quickBrowseEnabled?: string;
  quickBrowseButtons?: string | { label: string; action: string }[];
  productComparisonEnabled?: string;
  whatsappOrderEnabled?: string;
  whatsappOrderNumber?: string;
  whatsappOrderMessage?: string;
  addToCartEnabled?: string;
  footerLabelEnabled?: string;
  footerLabelText?: string;
  poweredByEnabled?: string;
  jobPortalEnabled?: boolean;
  createdAt: string;
  updatedAt: string;
}

// Helper functions for visitor tracking
const getDeviceInfo = () => {
  const ua = navigator.userAgent;
  
  // Detect device type
  let deviceType = 'desktop';
  if (/Mobi|Android/i.test(ua)) {
    deviceType = /Tablet|iPad/i.test(ua) ? 'tablet' : 'mobile';
  }
  
  // Detect browser
  let browser = 'Unknown';
  if (ua.includes('Firefox')) browser = 'Firefox';
  else if (ua.includes('SamsungBrowser')) browser = 'Samsung';
  else if (ua.includes('Opera') || ua.includes('OPR')) browser = 'Opera';
  else if (ua.includes('Trident')) browser = 'IE';
  else if (ua.includes('Edge')) browser = 'Edge';
  else if (ua.includes('Edg')) browser = 'Edge';
  else if (ua.includes('Chrome')) browser = 'Chrome';
  else if (ua.includes('Safari')) browser = 'Safari';
  
  // Detect OS
  let os = 'Unknown';
  if (ua.includes('Windows')) os = 'Windows';
  else if (ua.includes('Mac OS')) os = 'macOS';
  else if (ua.includes('Linux')) os = 'Linux';
  else if (ua.includes('Android')) os = 'Android';
  else if (ua.includes('iOS') || ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS';
  
  return { deviceType, browser, os, userAgent: ua };
};

const getUTMParams = () => {
  const params = new URLSearchParams(window.location.search);
  return {
    utmSource: params.get('utm_source') || undefined,
    utmMedium: params.get('utm_medium') || undefined,
    utmCampaign: params.get('utm_campaign') || undefined,
  };
};

export default function EmbedChat() {
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isOnline, setIsOnline] = useState(false);
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null);
  const [isVoiceModeOpen, setIsVoiceModeOpen] = useState(false);
  const [isInlineVoiceActive, setIsInlineVoiceActive] = useState(false);
  const inlineVoiceAIMessagesRef = useRef<Map<string, string>>(new Map());
  const [selectedLanguage, setSelectedLanguage] = useState<string>('auto');
  const [isLanguageDropdownOpen, setIsLanguageDropdownOpen] = useState(false);
  const [selectedImage, setSelectedImage] = useState<File | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const [showCropOverlay, setShowCropOverlay] = useState(false);
  const [pendingSearchImageUrl, setPendingSearchImageUrl] = useState<string | null>(null);
  const [showTryOnOverlay, setShowTryOnOverlay] = useState(false);
  const [tryOnProduct, setTryOnProduct] = useState<{imageUrl: string; name: string; type?: string} | null>(null);
  const [expandedImageUrl, setExpandedImageUrl] = useState<string | null>(null);
  const [visitorSessionId, setVisitorSessionId] = useState<string | null>(null);
  const [parentPageUrl, setParentPageUrl] = useState<string | null>(null);
  const [isUserAtBottom, setIsUserAtBottom] = useState(true);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isHistoryPanelOpen, setIsHistoryPanelOpen] = useState(false);
  const [conversationsList, setConversationsList] = useState<Array<{id: string; title: string; updatedAt: string; messageCount: number}>>([]);
  const [isLoadingConversations, setIsLoadingConversations] = useState(false);
  const [activeFormStep, setActiveFormStep] = useState<FormStepData | null>(null);
  const [activeJourneyId, setActiveJourneyId] = useState<string | null>(null);
  const [isFormJourneyComplete, setIsFormJourneyComplete] = useState(false); // Track when form journey is complete - disables chat input
  const [introLoaded, setIntroLoaded] = useState(false); // Track when intro has been fetched
  const [compareProducts, setCompareProducts] = useState<Set<string>>(new Set());
  const [allProducts, setAllProducts] = useState<any[]>([]);
  const [showComparisonView, setShowComparisonView] = useState(false);
  const [featuredProducts, setFeaturedProducts] = useState<any[]>([]);
  const [featuredProductsTitle, setFeaturedProductsTitle] = useState('Featured Products');
  const [cleanModeEnabled, setCleanModeEnabled] = useState(false);
  const [proactiveGuidanceChecked, setProactiveGuidanceChecked] = useState(false);
  const [ruleConversationStarters, setRuleConversationStarters] = useState<string[] | null>(null);
  const [isMenuMode, setIsMenuMode] = useState(false);
  const [menuEnabled, setMenuEnabled] = useState<boolean | null>(null);
  const proactiveGuidanceAppliedRef = useRef(false);
  const sentChatMenuItemsRef = useRef<Set<string>>(new Set());
  const menuDropdownRef = useRef<HTMLDivElement>(null);
  const languageDropdownRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  
  // Detect mobile device once on mount
  const isMobileDevice = useRef(getDeviceInfo().deviceType === 'mobile').current;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const resumeInputRef = useRef<HTMLInputElement>(null);
  const pendingResumeContextIdRef = useRef<string | null>(null);
  const [resumeUploadStage, setResumeUploadStage] = useState<'idle' | 'uploading' | 'analyzing' | 'matching'>('idle');
  const { toast } = useToast();

  // Session ID for conversation persistence (stored per businessAccountId)
  const sessionIdRef = useRef<string>('');
  const [isRestoringHistory, setIsRestoringHistory] = useState(true);
  
  // Generate unique user ID for widget (persists across session for voice mode)
  const widgetUserIdRef = useRef<string>(`widget_${crypto.randomUUID()}`);
  
  // Visitor session tracking token (persisted in localStorage for return visitors)
  const visitorSessionTokenRef = useRef<string>('');
  
  // Track session start time for duration calculation
  const sessionStartTimeRef = useRef<number>(Date.now());
  
  // Get businessAccountId for urgency offer hook
  const [urgencyBusinessId, setUrgencyBusinessId] = useState<string | undefined>(undefined);
  
  // Urgency offer hook for AI-powered intent detection
  const {
    activeOffer,
    redeemOffer,
    dismissOffer,
    acknowledgeRedemption,
    checkMessageIntent,
  } = useUrgencyOffer({
    businessAccountId: urgencyBusinessId,
    sessionId: sessionIdRef.current,
    enabled: !!urgencyBusinessId,
  });
  
  // Mobile viewport height updater with Visual Viewport API for stable keyboard handling
  useEffect(() => {
    // Update custom property for mobile viewport height
    function updateViewportHeight() {
      if (window.innerWidth <= 480) {
        // Use visualViewport if available (better for keyboard handling)
        const height = window.visualViewport?.height ?? window.innerHeight;
        const vh = height * 0.01;
        document.documentElement.style.setProperty('--hichroney-vh', `${vh}px`);
      }
    }

    // Debounced resize handler for window resize events
    let resizeTimeout: NodeJS.Timeout;
    function handleResize() {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(updateViewportHeight, 50);
    }

    // Update on mount
    updateViewportHeight();
    
    // Use Visual Viewport API for precise keyboard handling (if available)
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', updateViewportHeight);
      window.visualViewport.addEventListener('scroll', updateViewportHeight);
    }
    
    // Fallback to window events
    window.addEventListener('resize', handleResize);
    window.addEventListener('orientationchange', updateViewportHeight);
    
    // Also update when keyboard shows/hides (focus/blur events)
    window.addEventListener('focus', updateViewportHeight, true);
    window.addEventListener('blur', updateViewportHeight, true);

    return () => {
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', updateViewportHeight);
        window.visualViewport.removeEventListener('scroll', updateViewportHeight);
      }
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('orientationchange', updateViewportHeight);
      window.removeEventListener('focus', updateViewportHeight, true);
      window.removeEventListener('blur', updateViewportHeight, true);
    };
  }, []);
  
  // Track if visitor session has been started
  const visitorSessionStartedRef = useRef<boolean>(false);
  
  // Get businessAccountId from URL params using React state to ensure it reads correctly
  const [businessAccountId, setBusinessAccountId] = useState<string | null>(null);
  
  // Track if auto-open is requested
  const shouldAutoOpenVoiceRef = useRef(false);
  
  // Track if EMBED_READY has been sent
  const hasSignaledReadyRef = useRef(false);
  
  // Queue for pending starter messages (received before businessAccountId is ready)
  // Using state instead of ref so React re-renders and queue processor effect runs
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  
  // Inactivity nudge tracking - supports sequential messages
  const lastAIMessageTimeRef = useRef<number | null>(null);
  const inactivityNudgeSentRef = useRef<boolean>(false);
  const inactivityTimerRef = useRef<NodeJS.Timeout | null>(null);
  const inactivityNudgeIndexRef = useRef<number>(0); // Track which message in sequence we're on
  
  // Welcome back tracking - for returning visitors after 30+ minutes
  const isWelcomeBackRef = useRef<boolean>(false);
  
  // External guidance mode - when parent sends PROACTIVE_GUIDANCE, skip normal welcome/history
  const externalGuidanceModeRef = useRef<boolean>(false);

  useEffect(() => {
    // Get businessAccountId, autoOpenVoice, and guidanceMode from URL params
    const urlParams = new URLSearchParams(window.location.search);
    let id = urlParams.get('businessAccountId');
    let autoOpenVoice = urlParams.get('autoOpenVoice');
    let guidanceMode = urlParams.get('guidanceMode');
    
    // If not in search params, try hash (for client-side routing)
    if (!id && window.location.hash) {
      const hash = window.location.hash;
      if (hash.includes('?')) {
        const hashParams = new URLSearchParams(hash.split('?')[1]);
        id = hashParams.get('businessAccountId');
        autoOpenVoice = hashParams.get('autoOpenVoice');
        guidanceMode = hashParams.get('guidanceMode');
      }
    }
    
    if (id) {
      setBusinessAccountId(id);
      setUrgencyBusinessId(id);
    }
    
    if (autoOpenVoice === 'true') {
      shouldAutoOpenVoiceRef.current = true;
    }
    
    // CRITICAL: If guidanceMode=true is set, immediately enable clean mode
    // This ensures optional elements (featured products, default conversation starters,
    // quick browse buttons, nudges) are NEVER rendered - no race conditions
    if (guidanceMode === 'true') {
      console.log('[EmbedChat] 🎯 Guidance mode enabled via URL param - clean mode activated');
      setCleanModeEnabled(true);
      setProactiveGuidanceChecked(true); // Mark as checked so we don't wait for rules fetch
      externalGuidanceModeRef.current = true;
    }
  }, []);

  useEffect(() => {
    if (!businessAccountId) return;
    if (visitorSessionTokenRef.current) return;
    const perBusinessKey = `chroney_visitor_${businessAccountId}`;
    const globalKey = 'chroney_visitor_token';
    let token = localStorage.getItem(perBusinessKey) || localStorage.getItem(globalKey);
    if (!token) {
      token = crypto.randomUUID();
    }
    localStorage.setItem(perBusinessKey, token);
    localStorage.setItem(globalKey, token);
    visitorSessionTokenRef.current = token;
  }, [businessAccountId]);

  // Fetch widget settings for this business account
  const { data: settings, isLoading: isLoadingSettings } = useQuery<WidgetSettings>({
    queryKey: [`/api/widget-settings/public?businessAccountId=${businessAccountId}`],
    enabled: !!businessAccountId,
  });
  
  // Check if menu navigation is enabled for this business
  useEffect(() => {
    const checkMenuEnabled = async () => {
      if (!businessAccountId) return;
      try {
        const response = await fetch(`/api/chat-menu/public?businessAccountId=${businessAccountId}`);
        const data = await response.json();
        const enabled = data.enabled === true;
        setMenuEnabled(enabled);
      } catch (error) {
        console.error('[MenuCheck] Failed to check menu status:', error);
        setMenuEnabled(false);
      }
    };
    checkMenuEnabled();
  }, [businessAccountId]);
  
  // Track if we've already decided on initial mode (to prevent re-triggering)
  const menuModeDecidedRef = useRef(false);
  
  // Auto-switch to menu mode after history is restored if menu is enabled and no messages
  useEffect(() => {
    // Only auto-set menu mode once, after history restoration completes
    if (!menuModeDecidedRef.current && !isRestoringHistory && menuEnabled !== null) {
      menuModeDecidedRef.current = true;
      if (menuEnabled && messages.length === 0 && !pendingMessage) {
        setIsMenuMode(true);
      }
    }
  }, [isRestoringHistory, menuEnabled, messages.length, pendingMessage]);
  
  // Track conversationId for persistence (stored in localStorage after first message)
  const conversationIdRef = useRef<string>('');
  
  // Initialize sessionId from localStorage and restore conversation history
  useEffect(() => {
    if (!businessAccountId) return;
    
    const sessionStorageKey = `chroney_session_${businessAccountId}`;
    const conversationStorageKey = `chroney_conversation_${businessAccountId}`;
    const lastActivityKey = `chroney_last_activity_${businessAccountId}`;
    
    let storedSessionId = localStorage.getItem(sessionStorageKey);
    let storedConversationId = localStorage.getItem(conversationStorageKey);
    const lastActivityStr = localStorage.getItem(lastActivityKey);
    
    // Check if visitor is returning after 30+ minutes of inactivity
    const WELCOME_BACK_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
    const now = Date.now();
    
    // Parse last activity time with validity guard
    const lastActivity = lastActivityStr ? parseInt(lastActivityStr, 10) : null;
    const isValidLastActivity = lastActivity !== null && !Number.isNaN(lastActivity);
    
    // Check welcome back condition BEFORE updating timestamp
    if (isValidLastActivity && storedConversationId) {
      const timeSinceLastActivity = now - lastActivity;
      
      if (timeSinceLastActivity >= WELCOME_BACK_THRESHOLD_MS) {
        console.log(`[Welcome Back] Returning visitor after ${Math.round(timeSinceLastActivity / 60000)} minutes - starting new session`);
        
        // Start a fresh session for returning visitor
        const newSessionId = crypto.randomUUID();
        sessionIdRef.current = newSessionId;
        localStorage.setItem(sessionStorageKey, newSessionId);
        localStorage.removeItem(conversationStorageKey);
        conversationIdRef.current = '';
        
        // Mark this as a welcome back scenario
        isWelcomeBackRef.current = true;
        
        // Update last activity time AFTER decision is made
        localStorage.setItem(lastActivityKey, now.toString());
        
        setIsRestoringHistory(false);
        return;
      }
    }
    
    // Update last activity time AFTER welcome back check (normal flow)
    localStorage.setItem(lastActivityKey, now.toString());
    
    // Set up sessionId
    if (storedSessionId) {
      sessionIdRef.current = storedSessionId;
    } else {
      const newSessionId = crypto.randomUUID();
      sessionIdRef.current = newSessionId;
      localStorage.setItem(sessionStorageKey, newSessionId);
    }
    
    // If we have a stored conversationId, try to restore history
    // Skip if external guidance mode is active (demo pages control the messages)
    if (storedConversationId && !externalGuidanceModeRef.current) {
      conversationIdRef.current = storedConversationId;
      
      const restoreHistory = async () => {
        try {
          // Double-check external guidance mode before restoring
          if (externalGuidanceModeRef.current) {
            console.log('[EmbedChat] Skipping history restore - external guidance mode active');
            setIsRestoringHistory(false);
            return;
          }
          
          const response = await fetch(
            `/api/chat/widget/history?businessAccountId=${encodeURIComponent(businessAccountId)}&conversationId=${encodeURIComponent(storedConversationId!)}&sessionId=${encodeURIComponent(sessionIdRef.current)}`
          );
          
          if (response.ok) {
            const data = await response.json();
            // Final check before setting messages
            if (externalGuidanceModeRef.current) {
              console.log('[EmbedChat] Skipping history restore - external guidance mode active');
              setIsRestoringHistory(false);
              return;
            }
            
            if (data.messages && data.messages.length > 0) {
              // Restore messages from history
              const restoredMessages: ChatMessage[] = data.messages.map((msg: any) => ({
                id: msg.id,
                role: msg.role as 'user' | 'assistant',
                content: msg.content,
                timestamp: new Date(msg.timestamp)
              }));
              setMessages(restoredMessages);
              console.log('[EmbedChat] Restored', restoredMessages.length, 'messages from history');
              
              // Update conversationId if returned
              if (data.conversationId) {
                conversationIdRef.current = data.conversationId;
              }
            } else {
              // Conversation not found or empty - clear stored conversationId
              localStorage.removeItem(conversationStorageKey);
              conversationIdRef.current = '';
            }
          }
        } catch (error) {
          console.error('[EmbedChat] Failed to restore conversation history:', error);
        } finally {
          setIsRestoringHistory(false);
        }
      };
      
      restoreHistory();
    } else {
      if (externalGuidanceModeRef.current) {
        console.log('[EmbedChat] Skipping history restore - external guidance mode active');
      }
      setIsRestoringHistory(false);
    }
  }, [businessAccountId]);

  useEffect(() => {
    if (shouldAutoOpenVoiceRef.current && settings && !isLoadingSettings && settings.voiceModeEnabled) {
      console.log('[EmbedChat] Auto-opening voice mode after settings loaded');
      if (settings.chatMode === 'voice-only') {
        setIsVoiceModeOpen(true);
      } else {
        setIsInlineVoiceActive(true);
      }
      shouldAutoOpenVoiceRef.current = false;
    }
  }, [settings, isLoadingSettings]);

  // Use actual settings values
  const chatColor = settings?.chatColor || "#9333ea";
  const chatColorEnd = settings?.chatColorEnd || "#3b82f6";
  const widgetHeaderText = settings?.widgetHeaderText || "Hi Chroney";
  const currency = settings?.currency || "USD";
  const voiceModeStyle = settings?.voiceModeStyle || "circular";
  
  // Parse conversation starters from settings (or use rule-specific FAQs if available)
  const defaultStarters = settings?.conversationStarters 
    ? JSON.parse(settings.conversationStarters) 
    : [];
  // If rule FAQs are set (including empty array), use them; otherwise use default
  const conversationStarters = ruleConversationStarters !== null ? ruleConversationStarters : defaultStarters;
  // Clean mode only hides default starters, not rule-specific FAQs
  const isUsingRuleFaqs = ruleConversationStarters !== null && ruleConversationStarters.length > 0;
  // Wait for proactive guidance check before showing starters (unless rule FAQs are being used)
  const showStarters = settings?.conversationStartersEnabled !== 'false' && conversationStarters.length > 0 && (isUsingRuleFaqs || (!cleanModeEnabled && proactiveGuidanceChecked));
  
  // Determine if conversation starters should be visible
  const userMessages = messages.filter(m => m.role === 'user');
  const shouldShowStarters = showStarters && userMessages.length === 0 && !isLoading;
  
  // Language selector configuration
  const languageSelectorEnabled = settings?.languageSelectorEnabled !== 'false';
  const availableLanguages: string[] = settings?.availableLanguages 
    ? (() => {
        try {
          return JSON.parse(settings.availableLanguages);
        } catch {
          return ['auto', 'en', 'hi', 'kn', 'ta', 'mr'];
        }
      })()
    : ['auto', 'en', 'hi', 'kn', 'ta', 'mr'];
  
  // Close language dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (languageDropdownRef.current && !languageDropdownRef.current.contains(event.target as Node)) {
        setIsLanguageDropdownOpen(false);
      }
    };
    
    if (isLanguageDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isLanguageDropdownOpen]);
  
  // Close menu dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuDropdownRef.current && !menuDropdownRef.current.contains(event.target as Node)) {
        setIsMenuOpen(false);
      }
    };
    
    if (isMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isMenuOpen]);
  
  // Handle compare toggle for products
  const handleCompareToggle = (productId: string) => {
    setCompareProducts(prev => {
      const next = new Set(prev);
      if (next.has(productId)) {
        next.delete(productId);
      } else if (next.size < 3) {
        next.add(productId);
      }
      return next;
    });
    
    // Track product for comparison lookup
    messages.forEach(msg => {
      const products = [...(msg.products || []), ...(msg.matchedProducts || [])];
      products.forEach(p => {
        if (p.id === productId && !allProducts.find(ap => ap.id === productId)) {
          setAllProducts(prev => [...prev, p]);
        }
      });
    });
  };

  // Handle try-on for products
  const handleTryOn = (product: any) => {
    if (product.imageUrl) {
      setTryOnProduct({
        imageUrl: product.imageUrl,
        name: product.name,
        type: product.category || product.type || 'necklace'
      });
      setShowTryOnOverlay(true);
    }
  };

  // Handle quick browse button click - sends the action as a message
  const handleQuickBrowse = (action: string) => {
    if (sendMessageRef.current) {
      sendMessageRef.current(action);
    }
  };

  // Start a new chat - clear stored conversation and show welcome message
  const handleNewChat = async () => {
    if (!businessAccountId) return;
    
    if (conversationIdRef.current) {
      try {
        await fetch('/api/chat/widget/close-conversation', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversationId: conversationIdRef.current }),
        });
      } catch (e) {
        console.warn('[New Chat] Failed to close previous conversation:', e);
      }
    }
    
    // Generate new session and conversation IDs
    const newSessionId = crypto.randomUUID();
    sessionIdRef.current = newSessionId;
    conversationIdRef.current = '';
    
    // Update localStorage
    localStorage.setItem(`chroney_session_${businessAccountId}`, newSessionId);
    localStorage.removeItem(`chroney_conversation_${businessAccountId}`);
    
    // Clear messages and reset comparison state
    setMessages([]);
    setIsMenuOpen(false);
    setCompareProducts(new Set());
    setAllProducts([]);
    setShowComparisonView(false);
    setActiveFormStep(null);
    setActiveJourneyId(null);
    setIsFormJourneyComplete(false); // Reset journey complete state for new conversation
    
    // Reset inactivity nudge state to prevent old nudges from appearing
    inactivityNudgeSentRef.current = false;
    inactivityNudgeIndexRef.current = 0;
    lastAIMessageTimeRef.current = null;
    if (inactivityTimerRef.current) {
      clearTimeout(inactivityTimerRef.current);
      inactivityTimerRef.current = null;
    }
    
    // Load fresh intro message
    try {
      const langParam = selectedLanguage && selectedLanguage !== 'auto' ? `&language=${encodeURIComponent(selectedLanguage)}` : '';
      const response = await fetch(`/api/chat/widget/intro?businessAccountId=${encodeURIComponent(businessAccountId)}${langParam}`);
      if (response.ok) {
        const data = await response.json();
        
        // Check if this is a form journey that should start with a form step
        if (data.formStep) {
          console.log('[New Chat] Restarting form journey with step:', data.formStep);
          setActiveFormStep(data.formStep);
          if (data.journeyId) {
            setActiveJourneyId(data.journeyId);
          }
          // For form journeys with start-from-scratch, don't show duplicate intro text
          // The form UI already displays the question
        } else if (data.intro) {
          // Regular chat - just show intro message
          setMessages([{
            id: '1',
            role: 'assistant',
            content: data.intro,
            timestamp: new Date()
          }]);
        }
      }
    } catch (error) {
      console.error('Failed to load intro:', error);
    }
  };
  
  // Load conversation history list
  const loadConversationHistory = async () => {
    if (!businessAccountId) return;
    
    setIsLoadingConversations(true);
    try {
      const visitorToken = visitorSessionTokenRef.current;
      const response = await fetch(`/api/chat/widget/conversations?businessAccountId=${encodeURIComponent(businessAccountId)}&visitorToken=${encodeURIComponent(visitorToken)}`);
      if (response.ok) {
        const data = await response.json();
        setConversationsList(data.conversations || []);
      }
    } catch (error) {
      console.error('Failed to load conversations:', error);
    } finally {
      setIsLoadingConversations(false);
    }
  };
  
  // Open history panel
  const handleOpenHistory = () => {
    setIsMenuOpen(false);
    setIsHistoryPanelOpen(true);
    loadConversationHistory();
  };
  
  // Load a specific conversation from history
  const handleLoadConversation = async (convId: string) => {
    if (!businessAccountId) return;
    
    try {
      const response = await fetch(
        `/api/chat/widget/history?businessAccountId=${encodeURIComponent(businessAccountId)}&conversationId=${encodeURIComponent(convId)}`
      );
      
      if (response.ok) {
        const data = await response.json();
        if (data.messages && data.messages.length > 0) {
          const restoredMessages: ChatMessage[] = data.messages.map((msg: any) => ({
            id: msg.id,
            role: msg.role as 'user' | 'assistant',
            content: msg.content,
            timestamp: new Date(msg.timestamp)
          }));
          setMessages(restoredMessages);
          
          // Update stored conversation ID
          if (data.conversationId) {
            conversationIdRef.current = data.conversationId;
            localStorage.setItem(`chroney_conversation_${businessAccountId}`, data.conversationId);
          }
          
          setIsHistoryPanelOpen(false);
          toast({
            title: "Conversation Loaded",
            description: "Previous conversation restored",
          });
        }
      }
    } catch (error) {
      console.error('Failed to load conversation:', error);
      toast({
        title: "Error",
        description: "Failed to load conversation",
        variant: "destructive",
      });
    }
  };
  
  // Map currency code to symbol
  const currencySymbols: Record<string, string> = {
    USD: "$", EUR: "€", GBP: "£", JPY: "¥", CNY: "¥", INR: "₹", AUD: "A$",
    CAD: "C$", CHF: "CHF", SEK: "kr", NZD: "NZ$", SGD: "S$", HKD: "HK$",
    NOK: "kr", MXN: "$", BRL: "R$", ZAR: "R", KRW: "₩", TRY: "₺",
    RUB: "₽", IDR: "Rp", THB: "฿", MYR: "RM"
  };
  const currencySymbol = currencySymbols[currency] || "$";

  // Load intro message on mount and when language changes (only for chat modes, not voice-only)
  // Skip if history is being restored or has been restored with messages
  useEffect(() => {
    if (!businessAccountId || !settings || isRestoringHistory) return;
    if (introLoaded) return;
    if (activeFormStep) { setIntroLoaded(true); return; }
    
    // Skip intro loading for voice-only mode
    if (settings.chatMode === 'voice-only') return;
    
    // Skip intro if we have restored messages (user messages present)
    const hasUserMessages = messages.some(m => m.role === 'user');
    if (hasUserMessages) {
      setIsOnline(true);
      setIntroLoaded(true);
      return;
    }
    
    const loadIntro = async () => {
      try {
        // Include language parameter for translation
        const langParam = selectedLanguage && selectedLanguage !== 'auto' ? `&language=${encodeURIComponent(selectedLanguage)}` : '';
        // Check if this is a welcome back scenario (returning after 30+ minutes)
        const welcomeBackParam = isWelcomeBackRef.current ? '&welcomeBack=true' : '';
        const response = await fetch(`/api/chat/widget/intro?businessAccountId=${encodeURIComponent(businessAccountId)}${langParam}${welcomeBackParam}`);
        if (response.ok) {
          const data = await response.json();
          if (data.intro) {
            // For form journeys, don't add the intro as a chat message since the FormStep shows the question
            // Only add intro message for non-form journeys
            if (!data.formStep) {
              setMessages(prev => {
                if (prev.length === 0) {
                  return [{
                    id: '1',
                    role: 'assistant',
                    content: data.intro,
                    timestamp: new Date()
                  }];
                }
                // If first message exists and is assistant (intro), update it
                if (prev[0]?.role === 'assistant' && prev[0]?.id === '1') {
                  return [{ ...prev[0], content: data.intro }, ...prev.slice(1)];
                }
                return prev;
              });
            }
            setIsOnline(true);
            
            // Set active form step if it's a form journey
            if (data.formStep) {
              console.log('[Form Journey] Setting active form step from intro:', data.formStep);
              setActiveFormStep(data.formStep);
              if (data.journeyId) {
                setActiveJourneyId(data.journeyId);
              }
            }
            
            // Fetch featured products for carousel
            try {
              const featuredResponse = await fetch(`/api/chat/widget/featured-products?businessAccountId=${encodeURIComponent(businessAccountId)}`);
              if (featuredResponse.ok) {
                const featuredData = await featuredResponse.json();
                if (featuredData.enabled && featuredData.products?.length > 0) {
                  setFeaturedProducts(featuredData.products);
                  setFeaturedProductsTitle(featuredData.title || 'Featured Products');
                }
              }
            } catch (err) {
              console.error('Failed to load featured products:', err);
            }
            
            // Track intro message time for inactivity nudge
            lastAIMessageTimeRef.current = Date.now();
            
            // Reset welcome back flag after loading
            if (isWelcomeBackRef.current) {
              console.log('[Welcome Back] Welcome back message shown, resetting flag');
              isWelcomeBackRef.current = false;
            }
            
            // Mark intro as loaded
            setIntroLoaded(true);
          }
        } else {
          // Even if response not ok, mark as loaded so queue can proceed
          setIntroLoaded(true);
        }
      } catch (error) {
        console.error('Failed to load intro:', error);
        setIsOnline(false);
        // Mark intro as loaded even on error so queue can proceed
        setIntroLoaded(true);
      }
    };
    
    loadIntro();
  }, [businessAccountId, settings, selectedLanguage, isRestoringHistory, introLoaded]);

  // Visitor session tracking - start session and send heartbeats
  useEffect(() => {
    if (!businessAccountId || visitorSessionStartedRef.current) return;
    
    const startVisitorSession = async () => {
      try {
        const deviceInfo = getDeviceInfo();
        const utmParams = getUTMParams();
        
        // Get referrer (only if this is an embedded widget)
        const referrer = window.parent !== window ? document.referrer : document.referrer;
        
        // Start both session tracking and page visitor tracking in parallel
        // Use parentPageUrl from postMessage if available (most reliable)
        // Fall back to document.referrer if in iframe, or window.location.href otherwise
        const effectivePageUrl = parentPageUrl || (window.parent !== window ? document.referrer : window.location.href);
        console.log('[Visitor Tracking] Using pageUrl:', effectivePageUrl, '(parentPageUrl:', parentPageUrl, ')');
        
        const [sessionResponse] = await Promise.all([
          // Session tracking (for session-level analytics)
          fetch('/api/widget/session-start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              businessAccountId,
              sessionToken: visitorSessionTokenRef.current,
              pageUrl: effectivePageUrl,
              referrer: referrer || undefined,
              ...utmParams,
              ...deviceInfo,
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            }),
          }),
          // Page visitor tracking (for unique visitor counting)
          fetch('/api/widget/page-visit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              businessAccountId,
              visitorToken: visitorSessionTokenRef.current,
              pageUrl: effectivePageUrl,
              ...deviceInfo,
            }),
          }),
        ]);
        
        // Capture the server-returned session ID for lead tracking
        if (sessionResponse.ok) {
          const sessionData = await sessionResponse.json();
          if (sessionData.sessionId) {
            setVisitorSessionId(sessionData.sessionId);
            console.log('[Visitor Tracking] Got server session ID:', sessionData.sessionId);
          }
        }
        
        visitorSessionStartedRef.current = true;
        console.log('[Visitor Tracking] Session and page visitor started');
      } catch (error) {
        console.error('[Visitor Tracking] Failed to start session:', error);
      }
    };
    
    startVisitorSession();
    
    // Send heartbeat every 30 seconds to track session duration
    const heartbeatInterval = setInterval(async () => {
      if (!visitorSessionStartedRef.current) return;
      
      try {
        const durationSeconds = Math.floor((Date.now() - sessionStartTimeRef.current) / 1000);
        
        await fetch('/api/widget/session-heartbeat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionToken: visitorSessionTokenRef.current,
            businessAccountId,
            widgetOpened: true, // Widget is open if this component is rendered
            durationSeconds,
          }),
        });
      } catch (error) {
        console.error('[Visitor Tracking] Heartbeat failed:', error);
      }
    }, 30000); // Every 30 seconds
    
    return () => clearInterval(heartbeatInterval);
  }, [businessAccountId]);

  // Update visitor session with parent page URL when it arrives via postMessage
  // This handles the case where the session starts before the parent URL is received
  useEffect(() => {
    if (!parentPageUrl || !businessAccountId || !visitorSessionTokenRef.current) return;
    
    console.log('[Visitor Tracking] Updating session with parent page URL:', parentPageUrl);
    
    // Update the existing session with the correct pageUrl
    fetch('/api/widget/session-start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        businessAccountId,
        sessionToken: visitorSessionTokenRef.current,
        pageUrl: parentPageUrl,
      }),
    }).then(() => {
      console.log('[Visitor Tracking] Session updated with parent page URL');
    }).catch((error) => {
      console.error('[Visitor Tracking] Failed to update session with parent URL:', error);
    });
  }, [parentPageUrl, businessAccountId]);

  // Smart scroll: check if user is at bottom before messages change
  const checkIfAtBottom = () => {
    const container = messagesContainerRef.current;
    if (!container) return true;
    const threshold = 100; // pixels from bottom to consider "at bottom"
    return container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
  };

  // Handle scroll events to track user position
  const handleScroll = () => {
    const atBottom = checkIfAtBottom();
    setIsUserAtBottom(atBottom);
  };

  // Listen for messages from parent window (floating widget)
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // Handle visitor session initialization
      if (event.data && event.data.type === 'SESSION_INIT') {
        const visitorSession = event.data.visitorSessionId;
        console.log('[EmbedChat] ========== SESSION_INIT RECEIVED ==========');
        console.log('[EmbedChat] Visitor Session ID:', visitorSession);
        if (visitorSession) {
          setVisitorSessionId(visitorSession);
        }
        return;
      }
      
      // Handle parent page URL for lead source tracking (LeadSquared integration)
      // This is critical because document.referrer is unreliable in iframes
      if (event.data && event.data.type === 'PARENT_URL') {
        const pageUrl = event.data.pageUrl;
        console.log('[EmbedChat] ========== PARENT_URL RECEIVED ==========');
        console.log('[EmbedChat] Parent Page URL:', pageUrl);
        if (pageUrl) {
          setParentPageUrl(pageUrl);
        }
        return;
      }
      
      if (event.data && event.data.type === 'SEND_MESSAGE') {
        const messageText = event.data.message;
        const visitorSession = event.data.visitorSessionId;
        console.log('[EmbedChat] ========== SEND_MESSAGE RECEIVED ==========');
        console.log('[EmbedChat] Message:', messageText);
        console.log('[EmbedChat] Visitor Session ID:', visitorSession);
        console.log('[EmbedChat] businessAccountId:', businessAccountId);
        console.log('[EmbedChat] settings:', settings ? 'loaded' : 'not loaded');
        console.log('[EmbedChat] isLoadingSettings:', isLoadingSettings);
        console.log('[EmbedChat] isLoading:', isLoading);
        
        // Store visitorSessionId for discount tracking
        if (visitorSession && visitorSession !== visitorSessionId) {
          setVisitorSessionId(visitorSession);
        }
        
        if (messageText && messageText.trim()) {
          // Check if chat UI is fully ready (businessAccountId + settings loaded + not loading)
          const isUIReady = businessAccountId && settings && !isLoadingSettings && !isLoading;
          
          console.log('[EmbedChat] Is UI ready?', isUIReady);
          
          if (!isUIReady) {
            console.log('[EmbedChat] ❌ UI NOT READY - Queuing message:', messageText.trim());
            console.log('[EmbedChat] Queued message will be processed by queue processor effect');
            setPendingMessage(messageText.trim());
            return;
          }
          
          // UI is ready, send immediately using sendMessageRef
          console.log('[EmbedChat] ✅ UI READY - Sending message immediately via sendMessageRef');
          console.log('[EmbedChat] sendMessageRef.current:', sendMessageRef.current ? 'EXISTS' : 'NULL');
          console.log('[EmbedChat] isLoading:', isLoading);
          console.log('[EmbedChat] businessAccountId:', businessAccountId);
          if (sendMessageRef.current) {
            console.log('[EmbedChat] 🚀 Calling sendMessageRef.current with:', messageText.trim());
            sendMessageRef.current(messageText.trim()).catch((err) => {
              console.error('[EmbedChat] Error sending message:', err);
            });
            console.log('[EmbedChat] ✅ sendMessageRef.current called successfully');
          } else {
            console.error('[EmbedChat] ❌ sendMessageRef is null, falling back to pending queue');
            setPendingMessage(messageText.trim());
          }
        }
      }
      
      // Handle message with product context from Product Page AI Mode
      if (event.data && event.data.type === 'SEND_MESSAGE_WITH_CONTEXT') {
        const messageText = event.data.message;
        const productContext = event.data.productContext;
        console.log('[EmbedChat] ========== SEND_MESSAGE_WITH_CONTEXT RECEIVED ==========');
        console.log('[EmbedChat] Message:', messageText);
        console.log('[EmbedChat] Product context:', productContext);
        
        if (messageText && messageText.trim()) {
          // Prepend product context to the message for AI understanding
          let contextualMessage = messageText.trim();
          if (productContext && productContext.name) {
            contextualMessage = `[Asking about: ${productContext.name}${productContext.price ? ` - $${productContext.price}` : ''}] ${messageText.trim()}`;
          }
          
          const isUIReady = businessAccountId && settings && !isLoadingSettings && !isLoading;
          
          if (!isUIReady) {
            setPendingMessage(contextualMessage);
            return;
          }
          
          if (sendMessageRef.current) {
            sendMessageRef.current(contextualMessage).catch((err) => {
              console.error('[EmbedChat] Error sending product context message:', err);
            });
          } else {
            setPendingMessage(contextualMessage);
          }
        }
      }
      
      // Handle discount trigger from exit intent or idle timeout
      if (event.data && event.data.type === 'HICHRONEY_DISCOUNT_TRIGGER') {
        const { message: discountMessage, triggerType, discountPercentage, expiryMinutes } = event.data;
        console.log('[EmbedChat] ========== DISCOUNT TRIGGER RECEIVED ==========');
        console.log('[EmbedChat] Trigger type:', triggerType);
        console.log('[EmbedChat] Discount:', discountPercentage, '%');
        console.log('[EmbedChat] Message:', discountMessage);
        console.log('[EmbedChat] Expiry:', expiryMinutes, 'minutes');
        
        if (discountMessage) {
          // Add discount message as an AI assistant message
          const discountChatMessage: ChatMessage = {
            id: `discount_${Date.now()}`,
            role: 'assistant',
            content: discountMessage,
            timestamp: new Date()
          };
          
          setMessages(prev => [...prev, discountChatMessage]);
          
          // Track the discount trigger time for inactivity nudge
          lastAIMessageTimeRef.current = Date.now();
          
          console.log('[EmbedChat] ✅ Discount message added to chat');
        }
      }
      
      // Handle proactive guidance messages (for demo pages)
      if (event.data && event.data.type === 'PROACTIVE_GUIDANCE') {
        const { message: guidanceMessage, clearHistory, cleanMode, conversationStarters: ruleStarters } = event.data;
        console.log('[EmbedChat] ========== PROACTIVE GUIDANCE RECEIVED ==========');
        console.log('[EmbedChat] Guidance message:', guidanceMessage);
        console.log('[EmbedChat] Clear history:', clearHistory);
        console.log('[EmbedChat] Clean mode:', cleanMode);
        console.log('[EmbedChat] Rule starters:', ruleStarters);
        
        // Enable external guidance mode - prevents welcome message from overwriting
        externalGuidanceModeRef.current = true;
        
        // Mark proactive guidance as checked (from parent widget)
        setProactiveGuidanceChecked(true);
        
        // Apply clean mode if requested
        if (cleanMode === true) {
          console.log('[EmbedChat] Clean mode enabled from parent - hiding starters, products, nudges');
          setCleanModeEnabled(true);
        }
        
        // Apply rule-specific conversation starters
        if (Array.isArray(ruleStarters)) {
          if (ruleStarters.length > 0) {
            console.log('[EmbedChat] Applying rule conversation starters:', ruleStarters.length);
            setRuleConversationStarters(ruleStarters);
          } else {
            // Rule explicitly has empty starters - hide starters section
            console.log('[EmbedChat] Rule has empty starters - hiding starters');
            setRuleConversationStarters([]);
          }
        } else {
          // Rule doesn't define starters - reset to null to use defaults
          console.log('[EmbedChat] Rule has no starters defined - using defaults');
          setRuleConversationStarters(null);
        }
        
        if (guidanceMessage) {
          const guidanceChatMessage: ChatMessage = {
            id: `guidance_${Date.now()}`,
            role: 'assistant',
            content: guidanceMessage,
            timestamp: new Date()
          };
          
          if (clearHistory) {
            // Replace all messages with just this guidance
            setMessages([guidanceChatMessage]);
          } else {
            // Add to existing messages
            setMessages(prev => [...prev, guidanceChatMessage]);
          }
          
          lastAIMessageTimeRef.current = Date.now();
          console.log('[EmbedChat] ✅ Proactive guidance message added (external guidance mode enabled)');
        }
      }
    };
    
    window.addEventListener('message', handleMessage);
    
    return () => window.removeEventListener('message', handleMessage);
  }, [isLoading, businessAccountId, settings, isLoadingSettings]);
  
  // Signal readiness to parent window once (separate effect)
  useEffect(() => {
    // Only send once and only if we're in an iframe
    if (window.parent !== window && !hasSignaledReadyRef.current) {
      console.log('[EmbedChat] Sending EMBED_READY to parent window');
      window.parent.postMessage({ type: 'EMBED_READY' }, '*');
      hasSignaledReadyRef.current = true;
    }
  }, []); // Empty deps - only run once on mount
  
  // Track if fully ready signal has been sent
  const hasSignaledFullyReadyRef = useRef(false);
  
  // Signal WIDGET_FULLY_READY after settings are loaded and history is processed
  useEffect(() => {
    if (
      window.parent !== window && 
      !hasSignaledFullyReadyRef.current && 
      businessAccountId && 
      settings && 
      !isLoadingSettings && 
      !isRestoringHistory
    ) {
      console.log('[EmbedChat] Sending WIDGET_FULLY_READY to parent window');
      window.parent.postMessage({ type: 'WIDGET_FULLY_READY' }, '*');
      hasSignaledFullyReadyRef.current = true;
    }
  }, [businessAccountId, settings, isLoadingSettings, isRestoringHistory]);

  // Track previous offer to detect transitions (show -> hide)
  const prevOfferIdRef = useRef<string | null>(null);

  // Send urgency offer data to parent page for rendering outside iframe
  useEffect(() => {
    if (window.parent === window) return;
    if (activeOffer) {
      prevOfferIdRef.current = activeOffer.offerId;
      window.parent.postMessage({
        type: 'URGENCY_OFFER_SHOW',
        offer: {
          settings: activeOffer.settings,
          offerId: activeOffer.offerId,
          startedAt: activeOffer.startedAt,
          expiresAt: activeOffer.expiresAt,
          accentColor: chatColor,
        },
      }, '*');
    } else if (prevOfferIdRef.current) {
      prevOfferIdRef.current = null;
      window.parent.postMessage({ type: 'URGENCY_OFFER_HIDE' }, '*');
    }
  }, [activeOffer, chatColor]);

  // Listen for urgency offer actions from parent page
  useEffect(() => {
    if (window.parent === window) return;
    const handleOfferAction = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      if (!event.data || !event.data.type) return;
      if (event.data.type === 'URGENCY_OFFER_REDEEM') {
        redeemOffer(event.data.phoneNumber || '', conversationIdRef.current || undefined).then(() => {
          window.parent.postMessage({ type: 'URGENCY_OFFER_REDEEMED' }, '*');
        }).catch((err: any) => {
          window.parent.postMessage({ type: 'URGENCY_OFFER_REDEEM_ERROR', message: err.message }, '*');
        });
      } else if (event.data.type === 'URGENCY_OFFER_DISMISS') {
        dismissOffer();
      } else if (event.data.type === 'URGENCY_OFFER_ACKNOWLEDGE') {
        acknowledgeRedemption();
      }
    };
    window.addEventListener('message', handleOfferAction);
    return () => window.removeEventListener('message', handleOfferAction);
  }, [redeemOffer, dismissOffer, acknowledgeRedemption]);
  
  // Fetch and apply proactive guidance rules based on parent page URL
  useEffect(() => {
    // If we're not ready to check yet, wait
    if (!businessAccountId || !settings || isLoadingSettings || isRestoringHistory) {
      return;
    }
    
    // If guidance already applied from external source or previous check, mark as checked and skip
    if (proactiveGuidanceAppliedRef.current || externalGuidanceModeRef.current) {
      setProactiveGuidanceChecked(true);
      return;
    }
    
    // Run immediately (no 150ms delay) to prevent race conditions
    const applyProactiveGuidance = async () => {
      try {
        // Get parent page URL from various sources
        let parentUrl = '';
        const isInIframe = window.parent !== window;
        
        // First try to get from document referrer (most reliable for iframes)
        if (document.referrer) {
          try {
            const refUrl = new URL(document.referrer);
            parentUrl = refUrl.pathname + refUrl.search;
          } catch (e) {
            // If parsing fails, extract path manually
            const match = document.referrer.match(/https?:\/\/[^\/]+(\/[^\?#]*)?/);
            if (match && match[1]) {
              parentUrl = match[1];
            }
          }
        }
        
        // If in iframe, also try to get from parent URL params
        if (!parentUrl && isInIframe) {
          const urlParams = new URLSearchParams(window.location.search);
          const sourceUrl = urlParams.get('sourceUrl') || urlParams.get('parentUrl');
          if (sourceUrl) {
            parentUrl = sourceUrl;
          }
        }
        
        // FALLBACK: If NOT in an iframe (widget embedded directly on page), use current window location
        // This handles demo pages like /demo/razorpay-rize?step=1 where widget is part of the page
        if (!parentUrl && !isInIframe) {
          parentUrl = window.location.pathname + window.location.search;
          console.log('[ProactiveGuidance] Using current window URL (not in iframe):', parentUrl);
        }
        
        if (!parentUrl) {
          console.log('[ProactiveGuidance] No parent URL detected, skipping guidance check');
          return;
        }
        
        console.log('[ProactiveGuidance] Checking guidance rules for URL:', parentUrl);
        
        // Fetch active guidance rules for this business account
        const response = await fetch(`/api/public/proactive-guidance-rules/${encodeURIComponent(businessAccountId)}`);
        if (!response.ok) {
          console.log('[ProactiveGuidance] Failed to fetch rules:', response.status);
          return;
        }
        
        const rules = await response.json();
        if (!rules || rules.length === 0) {
          console.log('[ProactiveGuidance] No active guidance rules found');
          return;
        }
        
        // URL pattern matching function with safe regex handling
        const matchesPattern = (pattern: string, url: string): boolean => {
          try {
            // Exact match
            if (pattern === url) {
              return true;
            }
            
            // Wildcard pattern match (e.g., /pricing/* matches /pricing/enterprise)
            if (pattern.includes('*')) {
              // Escape all regex special chars, then convert * to .*
              // Note: We escape special chars first (not including *), then convert * to .*
              const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
              const regexPattern = escaped.replace(/\*/g, '.*');
              const regex = new RegExp(`^${regexPattern}$`);
              return regex.test(url);
            }
            
            // Prefix match (e.g., /checkout matches /checkout?step=2)
            if (url.startsWith(pattern)) {
              return true;
            }
            
            return false;
          } catch (e) {
            console.warn('[ProactiveGuidance] Pattern matching error for:', pattern, e);
            return false;
          }
        };
        
        // Find matching rule (rules are already sorted by priority)
        const matchingRule = rules.find((rule: any) => matchesPattern(rule.urlPattern, parentUrl));
        
        if (!matchingRule) {
          console.log('[ProactiveGuidance] No matching rule found for URL:', parentUrl);
          return;
        }
        
        console.log('[ProactiveGuidance] Found matching rule:', matchingRule.name);
        
        // Mark as applied
        proactiveGuidanceAppliedRef.current = true;
        externalGuidanceModeRef.current = true;
        
        // Apply clean mode if enabled (handle both string 'true' and boolean true)
        if (matchingRule.cleanMode === 'true' || matchingRule.cleanMode === true) {
          console.log('[ProactiveGuidance] Clean mode enabled - hiding starters, products, nudges');
          setCleanModeEnabled(true);
        }
        
        // Apply rule-specific FAQs if defined
        if (matchingRule.conversationStarters) {
          try {
            const ruleFaqs = typeof matchingRule.conversationStarters === 'string'
              ? JSON.parse(matchingRule.conversationStarters)
              : matchingRule.conversationStarters;
            if (Array.isArray(ruleFaqs)) {
              console.log('[ProactiveGuidance] Applying rule FAQs:', ruleFaqs.length);
              setRuleConversationStarters(ruleFaqs);
            }
          } catch (e) {
            console.warn('[ProactiveGuidance] Failed to parse rule FAQs:', e);
          }
        }
        
        // Add guidance message as first AI message
        const guidanceMessage: ChatMessage = {
          id: `guidance_${Date.now()}`,
          role: 'assistant',
          content: matchingRule.message,
          timestamp: new Date()
        };
        
        setMessages([guidanceMessage]);
        lastAIMessageTimeRef.current = Date.now();
        
        console.log('[ProactiveGuidance] Guidance message applied successfully');
        
      } catch (error) {
        console.error('[ProactiveGuidance] Error applying guidance:', error);
      } finally {
        // Mark proactive guidance check as complete regardless of outcome
        // This allows products/starters to show if no matching rule was found
        setProactiveGuidanceChecked(true);
      }
    };
    
    // Run immediately - no delay to prevent race conditions with element rendering
    applyProactiveGuidance();
  }, [businessAccountId, settings, isLoadingSettings, isRestoringHistory]);
  
  
  // Ref to hold sendMessage function for use in queue processor
  const sendMessageRef = useRef<((msg?: string) => Promise<void>) | null>(null);

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  // Word-by-word typing animation with adaptive gating for long responses
  const animateTyping = (
    fullText: string, 
    messageId: string, 
    products?: any[], 
    pagination?: ProductPagination,
    searchQuery?: string,
    appointmentSlots?: AppointmentSlotsData,
    jobs?: any[],
    applicantId?: string | null
  ) => {
    const words = fullText.split(' ');
    const wordCount = words.length;
    
    // Adaptive animation gating for perceived performance
    // Very long responses (200+ words): show immediately
    if (wordCount >= 200) {
      setMessages(prev => prev.map(msg => 
        msg.id === messageId 
          ? { 
              ...msg, 
              content: fullText, 
              products: products || msg.products,
              productPagination: pagination || msg.productPagination,
              productSearchQuery: searchQuery || msg.productSearchQuery,
              appointmentSlots: appointmentSlots || msg.appointmentSlots,
              jobs: jobs || msg.jobs,
              applicantId: applicantId !== undefined ? applicantId : msg.applicantId
            }
          : msg
      ));
      return;
    }
    
    // Calculate adaptive delay: faster for longer responses
    // Short (<50 words): 80ms, Medium (50-100): 50ms, Long (100-200): 30ms
    const delay = wordCount < 50 ? 80 : wordCount < 100 ? 50 : 30;
    let currentIndex = 0;

    // Set initial empty message
    setMessages(prev => prev.map(msg => 
      msg.id === messageId 
        ? { 
            ...msg, 
            content: '', 
            products: products || msg.products,
            productPagination: pagination || msg.productPagination,
            productSearchQuery: searchQuery || msg.productSearchQuery,
            appointmentSlots: appointmentSlots || msg.appointmentSlots,
            jobs: jobs || msg.jobs,
            applicantId: applicantId !== undefined ? applicantId : msg.applicantId
          }
        : msg
    ));

    const typingInterval = setInterval(() => {
      if (currentIndex < words.length) {
        const currentText = words.slice(0, currentIndex + 1).join(' ');
        setMessages(prev => 
          prev.map(msg => 
            msg.id === messageId 
              ? { 
                  ...msg, 
                  content: currentText, 
                  products: products || msg.products,
                  productPagination: pagination || msg.productPagination,
                  productSearchQuery: searchQuery || msg.productSearchQuery,
                  appointmentSlots: appointmentSlots || msg.appointmentSlots,
                  jobs: jobs || msg.jobs,
                  applicantId: applicantId !== undefined ? applicantId : msg.applicantId
                }
              : msg
          )
        );
        currentIndex++;
      } else {
        clearInterval(typingInterval);
      }
    }, delay);
  };

  // Handler for conversation starter selection
  const handleStarterSelect = (question: string) => {
    // Expand the widget first (in case it's minimized)
    window.parent.postMessage({ type: 'EXPAND_WIDGET' }, '*');
    
    setMessage(question);
    // Trigger send immediately
    setTimeout(() => {
      if (question.trim() && !isLoading && businessAccountId) {
        const sendBtn = document.querySelector('[data-send-button]') as HTMLButtonElement;
        if (sendBtn) sendBtn.click();
      }
    }, 100);
  };

  // Handle image selection - automatically uploads and searches when image is selected
  const handleResumeSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.type !== 'application/pdf') {
      toast({
        title: 'Invalid file',
        description: 'Please select a PDF file',
        variant: 'destructive'
      });
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      toast({
        title: 'File too large',
        description: 'Resume must be under 10MB',
        variant: 'destructive'
      });
      return;
    }

    if (resumeUploadStage !== 'idle' || isLoading) return;

    try {
      setResumeUploadStage('uploading');

      const formData = new FormData();
      formData.append('resume', file);
      formData.append('businessAccountId', businessAccountId || '');

      const response = await fetch('/api/chat/widget/resume-upload', {
        method: 'POST',
        body: formData,
      });

      setResumeUploadStage('analyzing');

      let result: any;
      try {
        result = await response.json();
      } catch {
        throw new Error('Could not process your resume. Please try again.');
      }

      if (!response.ok) {
        throw new Error(result.error || 'Upload failed');
      }

      if (result.status === 'failed' || !result.resumeContextId) {
        throw new Error(result.warning || 'Could not extract text from this resume. Please try a different file.');
      }

      if (result.warning) {
        toast({
          title: 'Resume processed with note',
          description: result.warning,
        });
      }

      setResumeUploadStage('matching');
      pendingResumeContextIdRef.current = result.resumeContextId;
      sendMessage(`[RESUME_UPLOAD] ${file.name}`);
    } catch (err: any) {
      setResumeUploadStage('idle');
      toast({
        title: 'Upload failed',
        description: err.message || 'Could not process your resume. Please try again.',
        variant: 'destructive'
      });
    }

    if (resumeInputRef.current) {
      resumeInputRef.current.value = '';
    }
  };

  const handleImageSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // Validate file type
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(file.type)) {
      toast({
        title: 'Invalid file type',
        description: 'Please select a JPEG, PNG, GIF, or WebP image.',
        variant: 'destructive'
      });
      return;
    }

    // Validate file size (10MB max)
    if (file.size > 10 * 1024 * 1024) {
      toast({
        title: 'File too large',
        description: 'Please select an image smaller than 10MB.',
        variant: 'destructive'
      });
      return;
    }

    // Create preview URL
    const previewUrl = URL.createObjectURL(file);
    
    // Automatically upload and show crop overlay
    if (!businessAccountId) return;

    setIsUploadingImage(true);

    try {
      // Upload the image first
      const formData = new FormData();
      formData.append('image', file);
      formData.append('businessAccountId', businessAccountId);

      const uploadResponse = await fetch('/api/chat/widget/upload-image', {
        method: 'POST',
        body: formData
      });

      if (!uploadResponse.ok) {
        throw new Error('Failed to upload image');
      }

      const uploadResult = await uploadResponse.json();
      const uploadedImageUrl = uploadResult.imageUrl;

      // Clean up preview URL
      URL.revokeObjectURL(previewUrl);

      // Show crop overlay for user to select area
      setPendingSearchImageUrl(uploadedImageUrl);
      setShowCropOverlay(true);
      setIsUploadingImage(false);

      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      return; // Stop here - search will happen when user clicks in crop overlay

    } catch (error) {
      console.error('[Image Upload] Error:', error);
      toast({
        title: 'Error',
        description: 'Failed to upload image. Please try again.',
        variant: 'destructive'
      });
      URL.revokeObjectURL(previewUrl);
      setIsUploadingImage(false);
      return;
    }
  };

  // Perform visual search after crop overlay confirms
  const performVisualSearch = async (imageUrl: string, boundingBox?: { x: number; y: number; width: number; height: number }) => {
    if (!businessAccountId) return;

    setIsLoading(true);
    setShowCropOverlay(false);

    try {
      // Add user message with image
      const userMessageId = Date.now().toString();
      const userMessage: ChatMessage = {
        id: userMessageId,
        role: 'user',
        content: 'Find products similar to this image',
        imageUrl: imageUrl,
        timestamp: new Date()
      };
      setMessages(prev => [...prev, userMessage]);

      // Add AI thinking message
      const aiMessageId = (Date.now() + 1).toString();
      setMessages(prev => [...prev, {
        id: aiMessageId,
        role: 'assistant',
        content: 'Analyzing your image...',
        timestamp: new Date()
      }]);

      // Call visual search endpoint (Vision Warehouse) with optional bounding box
      const matchResponse = await fetch('/api/chat/widget/visual-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessAccountId,
          imageUrl: imageUrl,
          boundingBox: boundingBox
        })
      });

      if (!matchResponse.ok) {
        throw new Error('Failed to match products');
      }

      const matchResult = await matchResponse.json();
      
      // Vision Warehouse returns products array directly
      let responseContent = '';
      let matchedProducts = matchResult.products || [];
      
      if (matchedProducts.length > 0) {
        responseContent = `I found ${matchedProducts.length} similar product${matchedProducts.length > 1 ? 's' : ''} in our catalog:`;
      } else {
        responseContent = "I couldn't find any matching products in our catalog. Would you like to describe what you're looking for?";
      }

      setMessages(prev => prev.map(msg => 
        msg.id === aiMessageId 
          ? { 
              ...msg, 
              content: responseContent,
              matchedProducts: matchedProducts
            }
          : msg
      ));

      // Clean up pending search state
      setPendingSearchImageUrl(null);

    } catch (error) {
      console.error('[Image Search] Error:', error);
      toast({
        title: 'Error',
        description: 'Failed to search for similar products. Please try again.',
        variant: 'destructive'
      });
    } finally {
      setIsLoading(false);
      setPendingSearchImageUrl(null);
    }
  };

  // Clear selected image
  const clearSelectedImage = () => {
    setSelectedImage(null);
    if (imagePreviewUrl) {
      URL.revokeObjectURL(imagePreviewUrl);
      setImagePreviewUrl(null);
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  // Upload image and show crop overlay for matching products
  const uploadAndMatchImage = async () => {
    if (!selectedImage || !businessAccountId) return;

    setIsUploadingImage(true);

    try {
      // Upload the image first
      const formData = new FormData();
      formData.append('image', selectedImage);
      formData.append('businessAccountId', businessAccountId);

      const uploadResponse = await fetch('/api/chat/widget/upload-image', {
        method: 'POST',
        body: formData
      });

      if (!uploadResponse.ok) {
        throw new Error('Failed to upload image');
      }

      const uploadResult = await uploadResponse.json();
      const uploadedImageUrl = uploadResult.imageUrl;

      // Show crop overlay for user to select area
      setPendingSearchImageUrl(uploadedImageUrl);
      setShowCropOverlay(true);
      clearSelectedImage();

    } catch (error: any) {
      console.error('[Image Upload] Error:', error);
      toast({
        title: 'Image upload failed',
        description: error.message || 'Failed to upload image',
        variant: 'destructive'
      });
    } finally {
      setIsUploadingImage(false);
    }
  };

  const sendMessage = async (overrideMessage?: string) => {
    const messageToSend = overrideMessage ?? message;
    if (!messageToSend.trim() || isLoading || !businessAccountId) return;
    const isResumeFlow = messageToSend.trim().startsWith('[RESUME_UPLOAD]');
    let resumeProgressCleared = false;

    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: messageToSend.trim(),
      timestamp: new Date()
    };

    setMessages(prev => [...prev, userMessage]);
    setMessage("");
    setIsLoading(true);
    
    // Update last activity time for welcome back tracking
    if (businessAccountId) {
      localStorage.setItem(`chroney_last_activity_${businessAccountId}`, Date.now().toString());
    }
    
    // Check this message for purchase intent (urgency offer)
    checkMessageIntent(messageToSend.trim(), conversationIdRef.current || undefined);
    
    // Store user message ID for scrolling after AI placeholder is added
    const userMsgIdForScroll = userMessage.id;
    void userMsgIdForScroll; // Used in scroll logic below
    
    // Keep focus on input field for continuous typing
    inputRef.current?.focus();

    // Track message sent event for visitor analytics
    if (visitorSessionStartedRef.current) {
      fetch('/api/widget/session-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionToken: visitorSessionTokenRef.current,
          businessAccountId,
          eventType: 'message_sent',
        }),
      }).catch(err => console.error('[Visitor Tracking] Event tracking failed:', err));
    }

    // Add placeholder AI message with typing indicator
    const aiMessageId = (Date.now() + 1).toString();
    setStreamingMessageId(aiMessageId);
    setMessages(prev => [...prev, {
      id: aiMessageId,
      role: 'assistant',
      content: '.....',
      timestamp: new Date()
    }]);

    // NOW scroll user's question to top - after AI placeholder adds enough height
    requestAnimationFrame(() => {
      setTimeout(() => {
        const container = messagesContainerRef.current;
        if (container) {
          const userMsgEl = container.querySelector(`[data-message-id="${userMsgIdForScroll}"]`) as HTMLElement;
          if (userMsgEl) {
            // Calculate scroll position to put user message at top
            const scrollTarget = userMsgEl.offsetTop - 16; // 16px padding from top
            container.scrollTop = scrollTarget;
          } else {
            container.scrollTop = container.scrollHeight;
          }
        }
      }, 50);
    });

    let productsData: any[] | undefined;
    let productsPagination: ProductPagination | undefined;
    let productsSearchQuery: string | undefined;
    let appointmentSlotsData: AppointmentSlotsData | undefined;
    let jobsDataItems: any[] | undefined;
    let jobsApplicantIdValue: string | null | undefined;

    try {
      const response = await fetch('/api/chat/widget/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          message: userMessage.content, 
          businessAccountId,
          sessionId: sessionIdRef.current,
          language: selectedLanguage !== 'auto' ? selectedLanguage : undefined,
          visitorSessionId: visitorSessionId || undefined,
          sessionToken: visitorSessionTokenRef.current,
          pageUrl: parentPageUrl || undefined,
          resumeContextId: pendingResumeContextIdRef.current || undefined,
        }),
      });

      if (!response.ok) throw new Error('Chat request failed');
      pendingResumeContextIdRef.current = null;

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) throw new Error('No response reader');

      setStreamingMessageId(aiMessageId);
      let streamedContent = '';
      let buffer = '';
      let pendingUpdate = false;

      const updateStreamingMessage = () => {
        if (pendingUpdate) return;
        pendingUpdate = true;
        
        requestAnimationFrame(() => {
          setMessages(prev => {
            const filtered = prev.filter(m => m.id !== aiMessageId);
            return [...filtered, {
              id: aiMessageId,
              role: 'assistant',
              content: streamedContent,
              timestamp: new Date(),
              products: productsData
            }];
          });
          pendingUpdate = false;
        });
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const jsonStr = line.slice(6);
            if (jsonStr === '[DONE]') continue;

            try {
              const data = JSON.parse(jsonStr);
              if (data.type === 'conversation_id') {
                // Store conversationId for persistence across page refreshes
                if (data.data && businessAccountId) {
                  conversationIdRef.current = data.data;
                  localStorage.setItem(`chroney_conversation_${businessAccountId}`, data.data);
                  console.log('[EmbedChat] Stored conversationId:', data.data);
                }
              } else if (data.type === 'content') {
                if (isResumeFlow && !resumeProgressCleared) {
                  resumeProgressCleared = true;
                  setResumeUploadStage('idle');
                }
                streamedContent += data.data;
                updateStreamingMessage();
              } else if (data.type === 'products') {
                const productResponse = JSON.parse(data.data);
                // Handle both old format (array) and new format (object with items/pagination)
                if (Array.isArray(productResponse)) {
                  productsData = productResponse;
                } else {
                  productsData = productResponse.items || [];
                  productsPagination = productResponse.pagination;
                  productsSearchQuery = productResponse.searchQuery;
                }
              } else if (data.type === 'jobs') {
                const jobsResponse = JSON.parse(data.data);
                jobsDataItems = jobsResponse.items || [];
                jobsApplicantIdValue = jobsResponse.applicantId || null;
                setMessages(prev => prev.map(msg =>
                  msg.id === aiMessageId
                    ? { ...msg, jobs: jobsDataItems, applicantId: jobsApplicantIdValue }
                    : msg
                ));
              } else if (data.type === 'appointment_slots') {
                // Handle appointment slots for calendar UI - update message immediately
                console.log('[Appointments] Received slots for calendar:', data.data);
                appointmentSlotsData = JSON.parse(data.data);
                // Update the current streaming message with slots immediately so calendar renders
                setMessages(prev => prev.map(msg => 
                  msg.id === aiMessageId 
                    ? { ...msg, appointmentSlots: appointmentSlotsData }
                    : msg
                ));
              } else if (data.type === 'discount_nudge') {
                // Handle discount nudge - show offer in chat
                console.log('[Discount Nudge] Received:', data.data);
                const nudge = data.data;
                const nudgeMessage = {
                  id: Date.now().toString(),
                  role: 'assistant' as const,
                  content: `🎉 **${nudge.message}**\n\n**Your Discount Code:** \`${nudge.discountCode}\`\n${nudge.expiresAt ? `Valid until: ${new Date(nudge.expiresAt).toLocaleTimeString()}` : 'Limited time offer!'}`,
                  timestamp: new Date()
                };
                setMessages(prev => [...prev, nudgeMessage]);
              } else if (data.type === 'form_step') {
                // Handle form step for form journeys - show visual input UI
                console.log('[Form Journey] Received form step:', data.data);
                const formStepData = typeof data.data === 'string' ? JSON.parse(data.data) : data.data;
                setActiveFormStep(formStepData);
                // Set active journey ID so form step submission works
                if (formStepData.journeyId) {
                  setActiveJourneyId(formStepData.journeyId);
                }
                // Set conversation ID so form step submission uses correct conversation
                if (formStepData.conversationId) {
                  conversationIdRef.current = formStepData.conversationId;
                  console.log('[EmbedChat] Set conversationId from form_step:', formStepData.conversationId);
                }
                // Check if form journey is complete - disable chat input
                if (formStepData.journeyComplete) {
                  console.log('[Form Journey] Journey complete - disabling chat input');
                  setIsFormJourneyComplete(true);
                }
              } else if (data.type === 'final') {
                // Use word-by-word animation for final response (smooth UX)
                animateTyping(data.data, aiMessageId, productsData, productsPagination, productsSearchQuery, appointmentSlotsData, jobsDataItems, jobsApplicantIdValue);
              }
            } catch (e) {
              console.error('Failed to parse SSE data:', e);
            }
          }
        }
      }
    } catch (error: any) {
      console.error('Chat error:', error);
      toast({
        title: "Error",
        description: error.message || "Failed to send message",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
      setStreamingMessageId(null);
      if (isResumeFlow && !resumeProgressCleared) {
        setResumeUploadStage('idle');
      }
      
      // Track when AI finished responding for inactivity nudge
      lastAIMessageTimeRef.current = Date.now();
      
      // Update last activity time when AI responds (for welcome back tracking)
      if (businessAccountId) {
        localStorage.setItem(`chroney_last_activity_${businessAccountId}`, Date.now().toString());
      }
    }
  };

  // Store sendMessage in ref for use in queue processor
  sendMessageRef.current = sendMessage;

  // Process queued pending message once UI is fully ready
  useEffect(() => {
    console.log('[Queue Processor] Effect triggered');
    console.log('[Queue Processor] businessAccountId:', businessAccountId);
    console.log('[Queue Processor] settings:', settings ? 'loaded' : 'not loaded');
    console.log('[Queue Processor] isLoadingSettings:', isLoadingSettings);
    console.log('[Queue Processor] isLoading:', isLoading);
    console.log('[Queue Processor] pendingMessage:', pendingMessage);
    console.log('[Queue Processor] introLoaded:', introLoaded);
    console.log('[Queue Processor] activeFormStep:', activeFormStep ? 'active' : 'null');
    
    // Wait for intro to load before processing pending message
    if (businessAccountId && settings && !isLoadingSettings && pendingMessage && !isLoading && introLoaded) {
      // If a form journey is active, discard the pending message - don't send to AI chat
      if (activeFormStep) {
        console.log('[Queue Processor] Form journey is active, discarding pending message to prevent AI chat overlay');
        setPendingMessage(null);
        return;
      }
      
      const queuedMessage = pendingMessage;
      console.log('[Queue Processor] ========== ALL CONDITIONS MET ==========');
      console.log('[Queue Processor] Processing queued message:', queuedMessage);
      
      if (sendMessageRef.current) {
        console.log('[Queue Processor] Calling sendMessage directly with:', queuedMessage);
        setPendingMessage(null);
        sendMessageRef.current(queuedMessage).catch((err) => {
          console.error('[Queue Processor] Error sending message, requeueing:', err);
          setPendingMessage(queuedMessage);
        });
      } else {
        console.error('[Queue Processor] sendMessageRef is null!');
      }
    } else {
      console.log('[Queue Processor] Conditions not met, waiting...');
    }
  }, [businessAccountId, settings, isLoadingSettings, isLoading, pendingMessage, introLoaded, activeFormStep]);

  // Inactivity nudge effect - sends sequential reminders if user stops responding
  useEffect(() => {
    if (!settings?.inactivityNudgeEnabled || settings.inactivityNudgeEnabled === 'false') return;
    if (cleanModeEnabled) return; // Skip nudges in clean mode
    if (isFormJourneyComplete) return; // Skip nudges after form journey is complete - chat is disabled
    if (!lastAIMessageTimeRef.current) return;
    if (messages.length < 1) return; // Need at least the intro message
    
    const lastMessage = messages[messages.length - 1];
    if (lastMessage?.role !== 'assistant') return; // Only trigger after AI responds
    if (isLoading) return; // Don't trigger while AI is thinking
    
    // Build full message sequence: first message + additional messages
    // When Smart Nudge is enabled, we support 2 nudges: AI-generated first, then "Are you there?"
    const isSmartNudgeEnabled = settings.smartNudgeEnabled === 'true';
    const baseDelay = parseInt(settings.inactivityNudgeDelay || "45");
    
    const allNudgeMessages: { message: string; delay: number }[] = [
      { 
        message: settings.inactivityNudgeMessage || "Still there? Let me know if you need any help!", 
        delay: baseDelay 
      }
    ];
    
    // When Smart Nudge is enabled, add a second "Are you there?" nudge
    if (isSmartNudgeEnabled) {
      allNudgeMessages.push({
        message: "Are you still there? I'm here to help if you need anything!",
        delay: baseDelay
      });
    } else if (settings.inactivityNudgeMessages && Array.isArray(settings.inactivityNudgeMessages)) {
      // For manual mode, use the configured additional messages
      allNudgeMessages.push(...settings.inactivityNudgeMessages);
    }
    
    const currentIndex = inactivityNudgeIndexRef.current;
    
    // Check if we've sent all messages (stop the sequence)
    if (currentIndex >= allNudgeMessages.length) return;
    
    const currentNudge = allNudgeMessages[currentIndex];
    const nudgeDelaySeconds = currentNudge.delay;
    const nudgeMessage = currentNudge.message;
    
    // Clear any existing timer
    if (inactivityTimerRef.current) {
      clearTimeout(inactivityTimerRef.current);
    }
    
    // Set new timer for current message in sequence
    inactivityTimerRef.current = setTimeout(async () => {
      // Check if user hasn't sent a message since last AI response
      const lastUserMessage = [...messages].reverse().find(m => m.role === 'user');
      const lastAIMessage = [...messages].reverse().find(m => m.role === 'assistant');
      
      if (lastAIMessage && (!lastUserMessage || lastAIMessage.timestamp > lastUserMessage.timestamp)) {
        let finalNudgeMessage = nudgeMessage;
        
        // Try smart nudge for FIRST nudge only (AI-generated contextual follow-up)
        // Second nudge uses the static "Are you there?" message
        const shouldUseSmartNudge = isSmartNudgeEnabled && currentIndex === 0;
        
        if (shouldUseSmartNudge && businessAccountId) {
          try {
            console.log('[Smart Nudge] Generating contextual follow-up...');
            
            // Prepare conversation history for smart nudge
            const conversationHistory = messages
              .filter(m => m.role === 'user' || m.role === 'assistant')
              .slice(-6)
              .map(m => ({ role: m.role, content: m.content }));

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000); // 5s timeout

            const response = await fetch('/api/chat/widget/smart-nudge', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                businessAccountId,
                conversationHistory,
                targetLanguage: selectedLanguage !== 'auto' ? selectedLanguage : undefined,
                visitorSessionId
              }),
              signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (response.ok) {
              const data = await response.json();
              if (data.nudgeMessage && data.isSmartNudge) {
                finalNudgeMessage = data.nudgeMessage;
                console.log('[Smart Nudge] Using AI-generated message:', finalNudgeMessage.slice(0, 50) + '...');
              } else {
                // Non-smart nudge response - treat as failure for translation purposes
                throw new Error('Smart nudge returned non-AI message');
              }
            } else {
              // HTTP error - throw to trigger fallback translation
              throw new Error(`Smart nudge failed with status ${response.status}`);
            }
          } catch (error: any) {
            if (error.name === 'AbortError') {
              console.log('[Smart Nudge] Timeout - falling back to static message');
            } else {
              console.error('[Smart Nudge] Failed - falling back to static message:', error?.message || error);
            }
            // Smart nudge failed - translate fallback message if non-English
            if (finalNudgeMessage === nudgeMessage && selectedLanguage && selectedLanguage !== 'auto' && selectedLanguage !== 'en' && businessAccountId) {
              try {
                const translateResponse = await fetch('/api/chat/widget/translate', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    businessAccountId,
                    text: nudgeMessage,
                    targetLanguage: selectedLanguage
                  })
                });
                if (translateResponse.ok) {
                  const data = await translateResponse.json();
                  if (data.translatedText) {
                    finalNudgeMessage = data.translatedText;
                  }
                }
              } catch (translateError) {
                console.error('Failed to translate fallback nudge:', translateError);
              }
            }
          }
        } else if (selectedLanguage && selectedLanguage !== 'auto' && selectedLanguage !== 'en' && businessAccountId) {
          // Translate static nudge message if non-English language is selected (smart nudge disabled)
          try {
            const response = await fetch('/api/chat/widget/translate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                businessAccountId,
                text: nudgeMessage,
                targetLanguage: selectedLanguage
              })
            });
            if (response.ok) {
              const data = await response.json();
              if (data.translatedText) {
                finalNudgeMessage = data.translatedText;
              }
            }
          } catch (error) {
            console.error('Failed to translate nudge:', error);
          }
        }
        
        const nudgeType = isSmartNudgeEnabled 
          ? (currentIndex === 0 ? 'AI contextual' : 'follow-up') 
          : 'manual';
        console.log(`[Inactivity Nudge] Showing ${nudgeType} message ${currentIndex + 1}/${allNudgeMessages.length}`);
        
        // Add nudge message as AI message
        inactivityNudgeSentRef.current = true;
        inactivityNudgeIndexRef.current = currentIndex + 1; // Move to next message in sequence
        
        setMessages(prev => [...prev, {
          id: `nudge-${Date.now()}`,
          role: 'assistant',
          content: finalNudgeMessage,
          timestamp: new Date()
        }]);
        
        // Save nudge to conversation history in database (if we have a conversationId)
        if (conversationIdRef.current) {
          fetch('/api/chat/widget/save-nudge', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              conversationId: conversationIdRef.current,
              message: finalNudgeMessage
            })
          }).catch(err => console.error('[Inactivity Nudge] Failed to save nudge:', err));
        }
        
        // Update the last AI message time to trigger the next nudge in sequence
        lastAIMessageTimeRef.current = Date.now();
        inactivityNudgeSentRef.current = false; // Allow next message to be scheduled
      }
    }, nudgeDelaySeconds * 1000);
    
    return () => {
      if (inactivityTimerRef.current) {
        clearTimeout(inactivityTimerRef.current);
      }
    };
  }, [messages, settings, isLoading, selectedLanguage, businessAccountId, isFormJourneyComplete]);
  
  // Clear inactivity timer when form journey completes
  useEffect(() => {
    if (isFormJourneyComplete && inactivityTimerRef.current) {
      clearTimeout(inactivityTimerRef.current);
      inactivityTimerRef.current = null;
      console.log('[Inactivity Nudge] Cleared timer - form journey complete');
    }
  }, [isFormJourneyComplete]);
  
  // Reset inactivity nudge when user sends a new message
  useEffect(() => {
    if (messages.length === 0) return;
    
    const lastMessage = messages[messages.length - 1];
    if (lastMessage?.role === 'user') {
      // User sent a message, reset the entire inactivity nudge sequence
      inactivityNudgeSentRef.current = false;
      inactivityNudgeIndexRef.current = 0; // Reset to first message in sequence
      lastAIMessageTimeRef.current = null;
      
      if (inactivityTimerRef.current) {
        clearTimeout(inactivityTimerRef.current);
        inactivityTimerRef.current = null;
      }
    }
  }, [messages]);
  
  // Cleanup timers on component unmount
  useEffect(() => {
    return () => {
      if (inactivityTimerRef.current) {
        clearTimeout(inactivityTimerRef.current);
        inactivityTimerRef.current = null;
      }
    };
  }, []);

  if (!businessAccountId) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center p-8">
          <p className="text-gray-600">Missing businessAccountId parameter</p>
        </div>
      </div>
    );
  }

  // Show loading state while settings load (especially important for auto-open voice mode)
  if (isLoadingSettings || !settings) {
    // Check if this is an auto-open voice request
    const urlParams = new URLSearchParams(window.location.search);
    const isAutoOpenVoice = urlParams.get('autoOpenVoice') === 'true';
    
    if (isAutoOpenVoice) {
      // Show minimal loading state for voice mode auto-open
      return (
        <div className="h-screen w-screen flex items-center justify-center" style={{ background: 'linear-gradient(135deg, #9333ea, #3b82f6)' }}>
          <div className="text-center">
            <div className="w-20 h-20 border-4 border-white/30 border-t-white rounded-full animate-spin mx-auto mb-4"></div>
            <p className="text-white text-sm">Connecting...</p>
          </div>
        </div>
      );
    }
    
    // Futuristic loading skeleton for standard chat mode
    // Uses h-full to respect parent container dimensions (not force full viewport)
    return (
      <div className="flex flex-col h-full min-h-0 bg-white overflow-hidden">
        {/* Skeleton Header */}
        <div className="flex-shrink-0 text-white shadow-md relative overflow-hidden" style={{ background: 'linear-gradient(135deg, #9333ea, #3b82f6)' }}>
          <div className="flex items-center justify-between p-3">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-white/20 animate-pulse" />
              <div className="space-y-2">
                <div className="w-24 h-4 bg-white/20 rounded animate-pulse" />
                <div className="w-16 h-3 bg-white/20 rounded animate-pulse" />
              </div>
            </div>
            <div className="w-8 h-8 rounded-full bg-white/20 animate-pulse" />
          </div>
          {/* Animated scan line */}
          <div className="absolute inset-0 overflow-hidden pointer-events-none">
            <div 
              className="absolute inset-x-0 h-[2px] bg-gradient-to-r from-transparent via-white/40 to-transparent"
              style={{
                animation: 'scanLine 2s ease-in-out infinite',
              }}
            />
          </div>
        </div>
        
        {/* Skeleton Chat Area */}
        <div className="flex-1 min-h-0 p-4 space-y-4 overflow-auto">
          {/* AI Message Skeleton */}
          <div className="flex justify-start">
            <div className="max-w-[80%] space-y-2">
              <div className="w-48 h-4 bg-gray-200 rounded animate-pulse" />
              <div className="w-64 h-4 bg-gray-200 rounded animate-pulse" />
              <div className="w-40 h-4 bg-gray-200 rounded animate-pulse" />
            </div>
          </div>
          
          {/* Typing indicator skeleton */}
          <div className="flex justify-start items-center gap-1">
            <div className="flex gap-1 p-3">
              <div className="w-2 h-2 bg-purple-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
              <div className="w-2 h-2 bg-purple-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
              <div className="w-2 h-2 bg-purple-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
            <span className="text-xs text-gray-400 ml-2">AI is warming up...</span>
          </div>
        </div>
        
        {/* Skeleton Input Area */}
        <div className="flex-shrink-0 p-3 border-t border-gray-100">
          <div className="flex items-center gap-2">
            <div className="flex-1 h-10 bg-gray-100 rounded-full animate-pulse" />
            <div className="w-10 h-10 rounded-full bg-gray-200 animate-pulse" />
          </div>
        </div>
        
        {/* Inline keyframes for scan line animation */}
        <style>{`
          @keyframes scanLine {
            0% { transform: translateY(-100%); opacity: 0; }
            10% { opacity: 1; }
            90% { opacity: 1; }
            100% { transform: translateY(400%); opacity: 0; }
          }
        `}</style>
      </div>
    );
  }

  // Function to close widget on mobile (sends message to parent)
  const handleCloseWidget = () => {
    console.log('[EmbedChat] Sending close message to parent');
    try {
      // Try to send message to parent window
      if (window.parent && window.parent !== window) {
        window.parent.postMessage('CLOSE_WIDGET', '*');
        console.log('[EmbedChat] Close message sent');
      } else {
        console.warn('[EmbedChat] No parent window found');
      }
    } catch (error) {
      console.error('[EmbedChat] Failed to send close message:', error);
    }
  };

  // If voice-only mode, render just the voice orb (not the chat interface)
  if (settings?.chatMode === 'voice-only' && settings?.voiceModeEnabled) {
    return (
      <>
        {/* Animated Voice Orb - positioned like chat bubble */}
        <div className="fixed bottom-5 right-5 w-24 h-24 z-50">
          {/* Outer pulse rings (shimmer effect) */}
          {[0, 1].map((index) => (
            <motion.div
              key={`pulse-${index}`}
              className="absolute inset-0 rounded-full border-2"
              style={{
                borderColor: `${chatColor}40`,
              }}
              initial={{ scale: 1, opacity: 0.6 }}
              animate={{
                scale: [1, 1.5, 1],
                opacity: [0.6, 0, 0.6],
              }}
              transition={{
                duration: 2.5,
                repeat: Infinity,
                delay: index * 1.25,
                ease: "easeOut"
              }}
            />
          ))}
          
          <motion.button
            onClick={() => setIsVoiceModeOpen(true)}
            className="w-24 h-24 shadow-2xl flex items-center justify-center overflow-hidden relative cursor-pointer"
            style={{ background: `linear-gradient(135deg, ${chatColor}, ${chatColorEnd})` }}
            aria-label="Start voice chat"
            animate={{
              scale: [1, 1.02, 1],
              borderRadius: ['50%', '48%', '50%', '52%', '50%'],
            }}
            transition={{
              scale: {
                duration: 3,
                repeat: Infinity,
                ease: "easeInOut"
              },
              borderRadius: {
                duration: 2,
                repeat: Infinity,
                ease: "easeInOut"
              }
            }}
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.95 }}
          >
          {/* Animated cloud blobs inside orb */}
          <div className="absolute inset-0 z-0">
            {/* Cloud blob 1 */}
            <motion.div
              className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-16 h-16 rounded-full"
              style={{
                background: 'radial-gradient(circle, rgba(255, 255, 255, 0.9) 0%, rgba(255, 255, 255, 0.4) 35%, transparent 65%)',
                filter: 'blur(15px)',
              }}
              animate={{
                x: ['-20px', '15px', '-20px'],
                y: ['-15px', '10px', '-15px'],
                scale: [1, 1.2, 1],
              }}
              transition={{
                duration: 6,
                repeat: Infinity,
                ease: "easeInOut"
              }}
            />
            
            {/* Cloud blob 2 */}
            <motion.div
              className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-20 h-20 rounded-full"
              style={{
                background: 'radial-gradient(circle, rgba(255, 255, 255, 0.85) 0%, rgba(255, 255, 255, 0.35) 35%, transparent 65%)',
                filter: 'blur(18px)',
              }}
              animate={{
                x: ['18px', '-18px', '18px'],
                y: ['12px', '-15px', '12px'],
                scale: [1.1, 0.9, 1.1],
              }}
              transition={{
                duration: 7,
                repeat: Infinity,
                ease: "easeInOut",
                delay: 0.8
              }}
            />
            
            {/* Cloud blob 3 */}
            <motion.div
              className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
              style={{
                width: '72px',
                height: '72px',
                background: 'radial-gradient(circle, rgba(255, 255, 255, 0.88) 0%, rgba(255, 255, 255, 0.38) 35%, transparent 65%)',
                filter: 'blur(16px)',
              }}
              animate={{
                x: ['-12px', '18px', '-12px'],
                y: ['15px', '-12px', '15px'],
                scale: [1, 1.3, 1],
              }}
              transition={{
                duration: 6.5,
                repeat: Infinity,
                ease: "easeInOut",
                delay: 1.5
              }}
            />
          </div>

          {/* Inner glow */}
          <motion.div 
            className="absolute inset-0 rounded-full blur-2xl z-0"
            animate={{
              opacity: [0.4, 0.6, 0.4],
            }}
            transition={{
              duration: 2.5,
              repeat: Infinity,
              ease: "easeInOut"
            }}
            style={{
              background: `radial-gradient(circle, ${chatColor}80, transparent)`,
            }}
          />
          
          {/* Avatar or mic icon */}
          {settings.avatarType && settings.avatarType !== 'none' ? (
            <div className="relative z-20 w-16 h-16 rounded-full overflow-hidden border-2 border-white/30 shadow-lg">
              <img 
                src={settings.avatarType === 'custom' ? settings.avatarUrl : `/avatars/avatar-${settings.avatarType.replace('preset-', '')}.png`}
                alt="AI Assistant"
                className="w-full h-full object-cover"
              />
            </div>
          ) : (
            <Mic className="relative z-20 w-10 h-10 text-white drop-shadow-lg" />
          )}
        </motion.button>

        {/* Voice Mode */}
        <Suspense fallback={<LazyLoadingFallback />}>
          <VoiceMode
            isOpen={isVoiceModeOpen}
            onClose={() => {
              setIsVoiceModeOpen(false);
              // If this was auto-opened from widget.js, notify parent to close iframe
              const urlParams = new URLSearchParams(window.location.search);
              if (urlParams.get('autoOpenVoice') === 'true') {
                handleCloseWidget();
              }
            }}
            userId={widgetUserIdRef.current}
            businessAccountId={businessAccountId}
            widgetHeaderText={widgetHeaderText}
            chatColor={chatColor}
            chatColorEnd={chatColorEnd}
            voiceModeStyle={voiceModeStyle}
            avatarType={settings?.avatarType}
            avatarUrl={settings?.avatarUrl}
          />
        </Suspense>
        </div>
      </>
    );
  }

  return (
    <div 
      className="flex flex-col bg-gray-50"
      style={{ 
        height: '100%',
        width: '100%',
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        overflow: 'hidden',
        overscrollBehavior: 'none',
        fontFamily: "'Poppins', sans-serif"
      }}
    >
      {/* Drag handle indicator for mobile bottom sheet */}
      <div className="w-full flex justify-center pt-2 pb-1 bg-transparent flex-shrink-0 md:hidden" style={{ background: `linear-gradient(to right, ${chatColor}, ${chatColorEnd})` }}>
        <div className="w-10 h-1 bg-white/40 rounded-full"></div>
      </div>
      
      {/* Chat Header - Compact in partial mode (small viewport height) */}
      <div 
        className="embed-chat-header flex items-center gap-2 px-3 py-2 text-white shadow-lg flex-shrink-0"
        style={{ background: `linear-gradient(to right, ${chatColor}, ${chatColorEnd})` }}
      >
        <div className="embed-chat-avatar w-7 h-7 rounded-full flex items-center justify-center overflow-hidden bg-white/20">
          {settings?.avatarType && settings.avatarType !== 'none' ? (
            <img 
              src={settings.avatarType === 'custom' ? settings.avatarUrl : `/avatars/avatar-${settings.avatarType.replace('preset-', '')}.png`}
              alt="AI Assistant"
              className="w-full h-full object-cover"
            />
          ) : (
            <img src="/c_logo.png" alt="AI Chroney" className="w-5 h-5 object-contain" />
          )}
        </div>
        <div className="flex-1">
          <h2 className="embed-chat-title font-semibold text-base">{widgetHeaderText}</h2>
        </div>
        {/* Language selector - show if enabled and has multiple languages */}
        {languageSelectorEnabled && availableLanguages.length > 1 && (
          <div className="relative" ref={languageDropdownRef}>
            <button
              onClick={() => setIsLanguageDropdownOpen(!isLanguageDropdownOpen)}
              className="embed-chat-btn px-2 py-1 rounded-md hover:bg-white/20 transition-colors flex items-center gap-1 text-sm"
              aria-label="Select language"
              title={`Language: ${LANGUAGE_CONFIG[selectedLanguage]?.name || 'Auto-detect'}`}
            >
              <span>{LANGUAGE_CONFIG[selectedLanguage]?.shortLabel || 'Auto'}</span>
              <ChevronDown className={`w-3 h-3 transition-transform ${isLanguageDropdownOpen ? 'rotate-180' : ''}`} />
            </button>
            
            {/* Language dropdown */}
            <AnimatePresence>
              {isLanguageDropdownOpen && (
                <motion.div
                  initial={{ opacity: 0, y: -10, scale: 0.95 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -10, scale: 0.95 }}
                  transition={{ duration: 0.15 }}
                  className="absolute right-0 top-full mt-1 bg-white rounded-lg shadow-xl border border-gray-200 py-1 z-50 min-w-[140px] max-h-[280px] overflow-y-auto"
                  style={{ maxWidth: 'calc(100vw - 40px)' }}
                >
                  <div className="px-3 py-1.5 text-xs font-semibold text-gray-500 border-b">
                    Languages
                  </div>
                  {availableLanguages.map((langCode) => {
                    const lang = LANGUAGE_CONFIG[langCode];
                    if (!lang) return null;
                    return (
                      <button
                        key={langCode}
                        onClick={() => {
                          setSelectedLanguage(langCode);
                          setIsLanguageDropdownOpen(false);
                        }}
                        className={`w-full px-3 py-2 text-left text-sm hover:bg-gray-100 flex items-center justify-between gap-2 transition-colors ${
                          selectedLanguage === langCode ? 'bg-purple-50 text-purple-700' : 'text-gray-700'
                        }`}
                      >
                        <span className="font-medium">{lang.nativeName}</span>
                        {selectedLanguage === langCode && (
                          <span className="text-purple-600">✓</span>
                        )}
                      </button>
                    );
                  })}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}
        {/* Voice mode button - only show if enabled and mode allows it */}
        {settings?.voiceModeEnabled && (settings?.chatMode === 'both' || settings?.chatMode === 'voice-only' || !settings?.chatMode) && (
          <button
            onClick={() => {
              if (isInlineVoiceActive) {
                setIsInlineVoiceActive(false);
              } else if (!isMenuMode && !activeFormStep && !isFormJourneyComplete) {
                setIsInlineVoiceActive(true);
              }
            }}
            className={`embed-chat-btn p-1 rounded-full transition-colors ${isInlineVoiceActive ? 'bg-white/30' : 'hover:bg-white/20'}`}
            aria-label="Voice mode"
            title="Voice mode"
          >
            <Mic className="w-4 h-4" />
          </button>
        )}
        
        {/* Three-dot menu */}
        <div className="relative" ref={menuDropdownRef}>
          <button
            onClick={() => setIsMenuOpen(!isMenuOpen)}
            className="embed-chat-btn p-1 rounded-full hover:bg-white/20 transition-colors"
            aria-label="Menu"
            title="Menu"
          >
            <MoreVertical className="w-4 h-4" />
          </button>
          
          <AnimatePresence>
            {isMenuOpen && (
              <motion.div
                initial={{ opacity: 0, y: -10, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -10, scale: 0.95 }}
                transition={{ duration: 0.15 }}
                className="absolute right-0 top-full mt-1 bg-white rounded-lg shadow-xl border border-gray-200 py-1 z-50 min-w-[160px]"
              >
                <button
                  onClick={handleNewChat}
                  className="w-full px-3 py-2 text-left text-sm hover:bg-gray-100 flex items-center gap-2 text-gray-700 transition-colors"
                >
                  <MessageSquarePlus className="w-4 h-4" />
                  <span>New Chat</span>
                </button>
                <button
                  onClick={handleOpenHistory}
                  className="w-full px-3 py-2 text-left text-sm hover:bg-gray-100 flex items-center gap-2 text-gray-700 transition-colors"
                >
                  <History className="w-4 h-4" />
                  <span>Conversation History</span>
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        
        {/* Close button - only visible on mobile */}
        <button
          onClick={handleCloseWidget}
          className="embed-chat-btn md:hidden p-1 rounded-full hover:bg-white/20 transition-colors"
          aria-label="Close chat"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Menu Navigation Mode - Show visual menu instead of chat */}
      {isMenuMode && menuEnabled && (
        <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
        <Suspense fallback={<LazyLoadingFallback />}>
          <ChatMenuNavigation
            businessAccountId={businessAccountId}
            chatColor={chatColor}
            chatColorEnd={chatColorEnd}
            avatarUrl={settings?.avatarType && settings.avatarType !== 'none' && !(settings.avatarType === 'custom' && !settings.avatarUrl) ? (settings.avatarType === 'custom' ? settings.avatarUrl : `/avatars/avatar-${settings.avatarType.replace('preset-', '')}.png`) : undefined}
            selectedLanguage={selectedLanguage}
            pageUrl={parentPageUrl || undefined}
            conversationId={conversationIdRef.current || undefined}
            onSwitchToChat={() => setIsMenuMode(false)}
            onSendMessage={(message, itemId) => {
              setIsMenuMode(false);
              if (sentChatMenuItemsRef.current.has(itemId)) {
                return;
              }
              sentChatMenuItemsRef.current.add(itemId);
              setMessage(message);
              setTimeout(() => {
                const sendBtn = document.querySelector('[data-send-button]') as HTMLButtonElement;
                if (sendBtn) sendBtn.click();
              }, 100);
            }}
            onStartJourney={async (journeyId) => {
              try {
                const response = await fetch(`/api/journey/${journeyId}/first-step?businessAccountId=${businessAccountId}`);
                if (!response.ok) {
                  console.error('[Menu] Failed to get journey first step');
                  return;
                }
                const data = await response.json();
                if (data.formStep) {
                  setMessages([]);
                  setIntroLoaded(true);
                  setIsMenuMode(false);
                  setActiveJourneyId(journeyId);
                  setActiveFormStep(data.formStep);
                  setIsFormJourneyComplete(false);
                }
              } catch (error) {
                console.error('[Menu] Error starting journey:', error);
              }
            }}
          />
        </Suspense>
        </div>
      )}

      {/* Back to Menu button - shown when menu is enabled but user is in chat/form view */}
      {!isMenuMode && menuEnabled && (
        <div className="bg-white border-b border-gray-100 px-3 py-2 flex items-center">
          <button
            onClick={() => {
              setIsMenuMode(true);
              setActiveFormStep(null);
              setIsFormJourneyComplete(false);
              setActiveJourneyId(null);
              if (messages.length === 0) {
                setIntroLoaded(false);
              }
            }}
            className="flex items-center gap-1.5 text-sm font-medium hover:opacity-80 transition-opacity"
            style={{ color: chatColor }}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m15 18-6-6 6-6"/>
            </svg>
            Back to Menu
          </button>
        </div>
      )}

      {/* Chat Messages - Takes remaining space with scroll containment */}
      {!isMenuMode && (
      <div 
        ref={messagesContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto overflow-x-hidden p-4 space-y-4 bg-white min-h-0 relative"
        style={{ 
          overscrollBehavior: 'contain',
          overscrollBehaviorX: 'contain',
          WebkitOverflowScrolling: 'touch',
          paddingBottom: '350px', // Extra space so any message can scroll to top
          overflowAnchor: 'none' // Prevent browser auto-adjusting scroll position
        }}
      >
        {messages.map((msg, msgIndex) => {
          const lastUserMsg = messages.slice(0, msgIndex).filter(m => m.role === 'user').at(-1)?.content || '';
          return (
          <div 
            key={msg.id}
            data-message-id={msg.id}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div className={`${(msg.products && msg.products.length > 0) || (msg.matchedProducts && msg.matchedProducts.length > 0) || (msg.jobs && msg.jobs.length > 0) ? 'w-full' : 'max-w-[85%]'} ${msg.role === 'user' ? 'order-2' : ''} ${msg.role === 'assistant' ? 'flex items-start gap-2' : ''}`}>
              {/* AI Avatar - shown for assistant messages */}
              {msg.role === 'assistant' && settings && (
                settings.avatarType && settings.avatarType !== 'none' && !(settings.avatarType === 'custom' && !settings.avatarUrl) ? (
                    <img
                      src={settings.avatarType === 'custom' ? settings.avatarUrl : `/avatars/avatar-${settings.avatarType.replace('preset-', '')}.png`}
                      alt={settings.widgetHeaderText || 'AI'}
                      className="w-8 h-8 rounded-full object-cover border border-gray-200 flex-shrink-0 mt-1"
                    />
                ) : (
                  <div
                    className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 mt-1 border border-gray-200 overflow-hidden"
                    style={{ background: `linear-gradient(135deg, ${chatColor}, ${chatColorEnd})` }}
                  >
                    <img src="/c_logo.png" alt="AI Chroney" className="w-6 h-6 object-contain" />
                  </div>
                )
              )}
              <div className="flex-1 min-w-0">
              <div
                className={`${
                  msg.role === 'user'
                    ? 'rounded-2xl px-4 py-3 text-white'
                    : 'py-1'
                }`}
                style={msg.role === 'user' ? { background: `linear-gradient(to right, ${chatColor}, ${chatColorEnd})` } : { color: '#1e3a5f' }}
              >
                {/* Show uploaded image in user message - compact clickable thumbnail */}
                {msg.role === 'user' && msg.imageUrl && (
                  <div className="mb-2">
                    <img 
                      src={msg.imageUrl} 
                      alt="Uploaded" 
                      className="w-16 h-16 object-cover rounded-lg border border-white/30 cursor-pointer hover:opacity-80 transition-opacity"
                      onClick={() => setExpandedImageUrl(msg.imageUrl || null)}
                    />
                  </div>
                )}
                {msg.role === 'assistant' && msg.content === '.....' ? (
                  <TypingIndicator />
                ) : msg.role === 'assistant' ? (
                  <div className="text-sm font-medium leading-relaxed prose prose-sm max-w-none prose-p:mb-2 prose-p:last:mb-0">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        p: ({ children }) => <p className="mb-2 last:mb-0 font-medium">{children}</p>,
                        ul: ({ children }) => <ul className="mb-2 pl-4 list-disc">{children}</ul>,
                        ol: ({ children }) => <ol className="mb-2 pl-4 list-decimal">{children}</ol>,
                        li: ({ children }) => <li className="mb-1">{children}</li>,
                        strong: ({ children }) => <strong className="font-bold">{children}</strong>,
                        em: ({ children }) => <em className="italic">{children}</em>,
                        a: ({ href, children }) => {
                          const handleClick = (e: React.MouseEvent) => {
                            e.preventDefault();
                            if (!href || href === 'null' || href === 'undefined') return;
                            const url = href.startsWith('http') ? href : `https://${href}`;
                            try {
                              if (window.parent && window.parent !== window) {
                                window.parent.postMessage({ type: 'OPEN_URL', url }, '*');
                              } else {
                                window.open(url, '_blank', 'noopener,noreferrer');
                              }
                            } catch {
                              window.open(url, '_blank', 'noopener,noreferrer');
                            }
                          };
                          return (
                            <a
                              href={href || '#'}
                              onClick={handleClick}
                              className="text-primary underline hover:opacity-80 cursor-pointer"
                              rel="noopener noreferrer"
                            >
                              {children}
                            </a>
                          );
                        },
                      }}
                    >
                      {msg.content}
                    </ReactMarkdown>
                  </div>
                ) : msg.role === 'user' && msg.content.startsWith('[RESUME_UPLOAD]') ? (
                  <div className="flex items-center gap-2 text-sm">
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 opacity-90">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                      <polyline points="14 2 14 8 20 8"/>
                      <line x1="16" y1="13" x2="8" y2="13"/>
                      <line x1="16" y1="17" x2="8" y2="17"/>
                      <polyline points="10 9 9 9 8 9"/>
                    </svg>
                    <span className="font-medium">{msg.content.replace('[RESUME_UPLOAD] ', '')} uploaded</span>
                  </div>
                ) : msg.role === 'user' && msg.content.startsWith('[JOB_APPLY]') ? (
                  <div className="flex items-center gap-2 text-sm">
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 opacity-90">
                      <rect x="2" y="7" width="20" height="14" rx="2" ry="2"/>
                      <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>
                    </svg>
                    <span className="font-medium">Applying for {msg.content.replace(/^\[JOB_APPLY\]\s*/, '').replace(/\s*\|jobId:.*$/, '')}</span>
                  </div>
                ) : (
                  <p className="text-sm whitespace-pre-wrap break-words">{msg.content}</p>
                )}
                {msg.products && msg.products.length > 0 && (
                  <div className="mt-3">
                    <ProductCard 
                      products={msg.products} 
                      currencySymbol={currencySymbol}
                      whatsappEnabled={settings?.whatsappOrderEnabled === 'true'}
                      whatsappNumber={settings?.whatsappOrderNumber}
                      whatsappMessage={settings?.whatsappOrderMessage}
                      comparisonEnabled={settings?.productComparisonEnabled === 'true'}
                      compareProducts={compareProducts}
                      onCompareToggle={handleCompareToggle}
                      chatColor={chatColor}
                      addToCartEnabled={settings?.addToCartEnabled !== 'false'}
                      tryOnEnabled={settings?.tryOnEnabled === 'true'}
                      onTryOn={handleTryOn}
                      pagination={msg.productPagination}
                      searchQuery={msg.productSearchQuery}
                      businessAccountId={businessAccountId}
                      userMessage={lastUserMsg}
                      selectedLanguage={selectedLanguage !== 'auto' ? selectedLanguage : undefined}
                      onLoadMore={(newProducts, newPagination) => {
                        const newMessageId = `more-products-${Date.now()}`;
                        
                        // Remove Show More from current message and create a new message with additional products
                        setMessages(prev => {
                          // Update original message to remove pagination (hide Show More)
                          const updatedMessages = prev.map(m => 
                            m.id === msg.id 
                              ? { ...m, productPagination: undefined }
                              : m
                          );
                          
                          // Create a new assistant message with the additional products
                          const newMessage = {
                            id: newMessageId,
                            role: 'assistant' as const,
                            content: 'Here are more options I found for you:',
                            products: newProducts,
                            productPagination: newPagination,
                            productSearchQuery: msg.productSearchQuery,
                            timestamp: new Date()
                          };
                          
                          return [...updatedMessages, newMessage];
                        });
                        
                        // Scroll to position the new message at top of visible area
                        // Use polling to wait for element to exist after React renders
                        const scrollToNewMessage = () => {
                          let attempts = 0;
                          const maxAttempts = 20;
                          
                          const tryScroll = () => {
                            const newMessageEl = document.querySelector(`[data-message-id="${newMessageId}"]`);
                            if (newMessageEl) {
                              newMessageEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
                            } else if (attempts < maxAttempts) {
                              attempts++;
                              requestAnimationFrame(tryScroll);
                            }
                          };
                          
                          requestAnimationFrame(tryScroll);
                        };
                        
                        scrollToNewMessage();
                      }}
                    />
                  </div>
                )}
                {/* Show matched products from image search - same style as regular products with similarity badge */}
                {msg.matchedProducts && msg.matchedProducts.length > 0 && (
                  <div className="mt-3">
                    <ProductCard 
                      products={msg.matchedProducts} 
                      currencySymbol={currencySymbol}
                      whatsappEnabled={settings?.whatsappOrderEnabled === 'true'}
                      whatsappNumber={settings?.whatsappOrderNumber}
                      whatsappMessage={settings?.whatsappOrderMessage}
                      comparisonEnabled={settings?.productComparisonEnabled === 'true'}
                      compareProducts={compareProducts}
                      onCompareToggle={handleCompareToggle}
                      chatColor={chatColor}
                      addToCartEnabled={settings?.addToCartEnabled !== 'false'}
                      tryOnEnabled={settings?.tryOnEnabled === 'true'}
                      onTryOn={handleTryOn}
                      businessAccountId={businessAccountId}
                      userMessage={lastUserMsg}
                      selectedLanguage={selectedLanguage !== 'auto' ? selectedLanguage : undefined}
                    />
                  </div>
                )}
                {msg.jobs && msg.jobs.length > 0 && (
                  <Suspense fallback={<div className="h-20 animate-pulse bg-gray-100 rounded-lg" />}>
                    <JobCarousel
                      jobs={msg.jobs}
                      chatColor={chatColor}
                      applicantId={msg.applicantId}
                      onApply={(jobId, appId, jobTitle) => {
                        sendMessage(`[JOB_APPLY] ${jobTitle} |jobId:${jobId}|applicantId:${appId}`);
                      }}
                    />
                  </Suspense>
                )}
                {/* Show try-on result image */}
                {msg.tryOnResult && (
                  <div className="mt-3">
                    <div 
                      className="relative rounded-lg overflow-hidden border-2 cursor-pointer group"
                      style={{ borderColor: chatColor }}
                      onClick={() => setExpandedImageUrl(msg.tryOnResult!)}
                    >
                      <img 
                        src={msg.tryOnResult} 
                        alt="Virtual try-on result" 
                        className="w-full h-auto max-h-[300px] object-contain"
                      />
                      <div className="absolute inset-0 bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                        <div className="bg-white/90 rounded-full p-2">
                          <svg className="w-6 h-6 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v3m0 0v3m0-3h3m-3 0H7" />
                          </svg>
                        </div>
                      </div>
                      <div className="absolute bottom-2 right-2 bg-white/90 rounded-full p-1.5 shadow-md">
                        <svg className="w-4 h-4 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                        </svg>
                      </div>
                    </div>
                    <p className="text-xs text-gray-400 text-center mt-1">Tap image to enlarge</p>
                    <div className="flex gap-2 mt-2">
                      <a 
                        href={msg.tryOnResult} 
                        download="try-on-result.png"
                        className="flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 transition-colors text-sm text-gray-700"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                        Save
                      </a>
                      <button 
                        className="flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 transition-colors text-sm text-gray-700"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (navigator.share) {
                            navigator.share({
                              title: 'Virtual Try-On Result',
                              text: 'Check out how this looks on me!',
                              url: msg.tryOnResult
                            }).catch(() => {});
                          } else {
                            navigator.clipboard.writeText(msg.tryOnResult || '');
                          }
                        }}
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
                        </svg>
                        Share
                      </button>
                    </div>
                  </div>
                )}
                {/* Show appointment calendar for slot selection */}
                {msg.appointmentSlots && Object.keys(msg.appointmentSlots.slots).length > 0 && (
                  <div className="mt-3">
                    <Suspense fallback={<LazyLoadingFallback />}>
                      <AppointmentCalendar
                        slots={msg.appointmentSlots.slots}
                        durationMinutes={msg.appointmentSlots.durationMinutes}
                        chatColor={chatColor}
                        chatColorEnd={chatColorEnd}
                        businessAccountId={businessAccountId || ''}
                        onSelectSlot={(date, time) => {
                          const formattedDate = new Date(date + 'T00:00:00').toLocaleDateString('en-US', { 
                            weekday: 'long', 
                            month: 'long', 
                            day: 'numeric' 
                          });
                          const [hours, minutes] = time.split(':').map(Number);
                          const period = hours >= 12 ? 'PM' : 'AM';
                          const displayHours = hours % 12 || 12;
                          const formattedTime = `${displayHours}:${minutes.toString().padStart(2, '0')} ${period}`;
                          
                          const bookingMessage = `I'd like to book an appointment on ${formattedDate} at ${formattedTime}`;
                          setMessage(bookingMessage);
                          setTimeout(() => {
                            const sendBtn = document.querySelector('[data-send-button]') as HTMLButtonElement;
                            if (sendBtn) sendBtn.click();
                          }, 100);
                        }}
                      />
                    </Suspense>
                  </div>
                )}
              </div>
              <div className="text-xs text-gray-400 mt-1">
                {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </div>
              </div>
            </div>
          </div>
        ); })}
        
        {/* Conversation Starters - Show after intro message, hide when form journey is active or complete */}
        {!activeFormStep && !isFormJourneyComplete && (
          <ConversationStarters
            starters={conversationStarters}
            onSelect={handleStarterSelect}
            chatColor={chatColor}
            chatColorEnd={chatColorEnd}
            show={shouldShowStarters}
          />
        )}

        {/* Chat Now button - shown after journey form completion */}
        {isFormJourneyComplete && !activeFormStep && (
          <div className="flex justify-center py-4 px-4">
            <button
              onClick={() => handleNewChat()}
              className="flex items-center gap-2 px-6 py-3 rounded-full text-white font-medium shadow-md hover:shadow-lg transition-all"
              style={{ background: chatColorEnd ? `linear-gradient(135deg, ${chatColor}, ${chatColorEnd})` : chatColor }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
              Chat Now
            </button>
          </div>
        )}

        {/* Quick Browse Buttons - Show after intro message (hide only when user sends first message) */}
        {/* Wait for proactive guidance check to complete before showing */}
        {settings?.quickBrowseEnabled === 'true' && settings?.quickBrowseButtons && userMessages.length === 0 && !isLoading && !cleanModeEnabled && proactiveGuidanceChecked && (() => {
          // Parse quickBrowseButtons if it's a JSON string
          let buttons = settings.quickBrowseButtons;
          if (typeof buttons === 'string') {
            try {
              buttons = JSON.parse(buttons);
            } catch (e) {
              buttons = [];
            }
          }
          return Array.isArray(buttons) && buttons.length > 0 ? (
            <QuickBrowseButtons
              buttons={buttons}
              onSelect={handleQuickBrowse}
              chatColor={chatColor}
              chatColorEnd={chatColorEnd}
            />
          ) : null;
        })()}

        {/* Product Carousel - Show featured products after intro (hide only when user sends first message) */}
        {/* Wait for proactive guidance check to complete before showing */}
        {featuredProducts.length > 0 && userMessages.length === 0 && !isLoading && !cleanModeEnabled && proactiveGuidanceChecked && (
          <Suspense fallback={<LazyLoadingFallback />}>
            <ProductCarousel
              products={featuredProducts}
              title={featuredProductsTitle}
              currencySymbol={currencySymbol}
              chatColor={chatColor}
              onProductClick={(product) => {
                setMessage(`Tell me more about ${product.name}`);
              }}
            />
          </Suspense>
        )}
        
        {/* Form Step UI - Show visual form input at the end of messages when form journey step is active */}
        {activeFormStep && (
          <div className="p-3 bg-white rounded-lg shadow-sm mx-2 mb-2 border border-gray-100">
            <Suspense fallback={<LazyLoadingFallback />}>
              <FormStep
                step={activeFormStep}
                businessAccountId={businessAccountId}
                conversationId={conversationIdRef.current || undefined}
              onSubmit={async (value) => {
                // Submit directly to the journey endpoint - no AI involvement
                try {
                  setIsLoading(true);
                  setActiveFormStep(null);
                  
                  const response = await fetch(`/api/journey/submit-step`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                      conversationId: conversationIdRef.current || null, 
                      answer: value, 
                      businessAccountId,
                      journeyId: activeJourneyId,
                      visitorToken: visitorSessionTokenRef.current || localStorage.getItem('chroney_visitor_token'),
                      pageUrl: parentPageUrl || (window.parent !== window ? document.referrer : window.location.href) || undefined
                    })
                  });
                  
                  const result = await response.json();
                  
                  // Update conversationId if we got a new one from the server
                  if (result.conversationId && !conversationIdRef.current) {
                    conversationIdRef.current = result.conversationId;
                    console.log('[Form Journey] Got conversationId from server:', result.conversationId);
                  }
                  
                  if (result.completed && result.nextStep?.stepType === 'journey_complete') {
                    // Journey complete step - show the completion step UI (with optional button)
                    setActiveFormStep(result.nextStep);
                    setActiveJourneyId(null); // Clear journey state on server side
                    setIsFormJourneyComplete(true); // Disable chat input after form journey completes
                  } else if (result.completed) {
                    // Journey completed - show completion message as chat message
                    const completionMessage: ChatMessage = {
                      id: (Date.now() + 1).toString(),
                      role: 'assistant',
                      content: result.completionMessage || 'Thank you for completing the form!',
                      timestamp: new Date()
                    };
                    setMessages(prev => [...prev, completionMessage]);
                    setActiveFormStep(null);
                    setActiveJourneyId(null); // Clear journey state
                    setIsFormJourneyComplete(true); // Disable chat input after form journey completes
                  } else if (result.nextStep) {
                    // Show next form step
                    setActiveFormStep(result.nextStep);
                  }
                } catch (error) {
                  console.error('[FormStep] Error submitting:', error);
                } finally {
                  setIsLoading(false);
                }
              }}
              isSubmitting={isLoading}
              primaryColor={chatColor}
              onContinueExploring={() => {
                setActiveFormStep(null);
                setActiveJourneyId(null);
              }}
            />
            </Suspense>
          </div>
        )}
        
        {resumeUploadStage !== 'idle' && (
          <div className="flex items-start gap-2 px-3 pb-2">
            {settings?.avatar && settings.avatar !== 'none' && (
              <div className="w-8 h-8 flex-shrink-0" />
            )}
            <div className="flex-1 max-w-[85%]">
              <ResumeUploadProgress stage={resumeUploadStage} chatColor={chatColor} />
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>
      )}

      {/* Chat Input - Fixed at bottom with safe area padding - only show if mode allows it */}
      {/* Also hide when form journey is complete - user cannot continue chatting after completing form journey */}
      {!isMenuMode && (settings?.chatMode === 'both' || settings?.chatMode === 'chat-only' || !settings?.chatMode) && !activeFormStep && !isFormJourneyComplete && (
        <div 
          className="border-t border-gray-200 p-2 sm:p-3 md:p-4 bg-gray-100 flex-shrink-0 mobile-input-debug" 
          style={{ 
            paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))',
            position: 'relative',
            zIndex: 99999
          }}
        >
          {isInlineVoiceActive && settings?.voiceModeEnabled && businessAccountId ? (
            <Suspense fallback={<LazyLoadingFallback />}>
              <InlineVoiceMode
                isActive={isInlineVoiceActive}
                onClose={() => {
                  setIsInlineVoiceActive(false);
                  inlineVoiceAIMessagesRef.current.clear();
                  setStreamingMessageId(null);
                }}
                userId={widgetUserIdRef.current}
                businessAccountId={businessAccountId}
                chatColor={chatColor}
                chatColorEnd={chatColorEnd}
                avatarType={settings?.avatarType}
                avatarUrl={settings?.avatarUrl}
                selectedLanguage={selectedLanguage}
                textConversationId={conversationIdRef.current || undefined}
                onUserMessage={(text) => {
                  const userMsg: ChatMessage = {
                    id: 'voice-user-' + Date.now(),
                    role: 'user',
                    content: text,
                    timestamp: new Date(),
                  };
                  setMessages(prev => [...prev, userMsg]);
                }}
                onTranscriptCorrection={(original, corrected) => {
                  setMessages(prev => prev.map(m => 
                    m.role === 'user' && m.content === original 
                      ? { ...m, content: corrected } 
                      : m
                  ));
                }}
                onAIMessageStart={(messageId) => {
                  inlineVoiceAIMessagesRef.current.set(messageId, '');
                  const aiMsg: ChatMessage = {
                    id: messageId,
                    role: 'assistant',
                    content: '',
                    timestamp: new Date(),
                  };
                  setMessages(prev => [...prev, aiMsg]);
                  setStreamingMessageId(messageId);
                }}
                onAIMessageChunk={(messageId, text) => {
                  const existing = inlineVoiceAIMessagesRef.current.get(messageId) || '';
                  const updated = existing + text;
                  inlineVoiceAIMessagesRef.current.set(messageId, updated);
                  setMessages(prev => prev.map(m => m.id === messageId ? { ...m, content: updated } : m));
                }}
                onAIMessageDone={(messageId) => {
                  setStreamingMessageId(null);
                  inlineVoiceAIMessagesRef.current.delete(messageId);
                }}
              />
            </Suspense>
          ) : (
          <>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/jpg,image/png,image/gif,image/webp"
            onChange={handleImageSelect}
            className="hidden"
          />
          
          <form 
            onSubmit={(e) => {
              e.preventDefault();
              sendMessage();
            }}
            className="relative"
            style={{ 
              margin: 0,
              padding: 0
            }}
          >
            <div className="relative">
              <textarea
                ref={inputRef as React.RefObject<HTMLTextAreaElement>}
                placeholder="Ask me anything..."
                value={message}
                onChange={(e) => {
                  setMessage(e.target.value);
                  const textarea = e.target;
                  textarea.style.height = 'auto';
                  const minHeight = isMobileDevice ? 48 : 44;
                  const maxHeight = 120;
                  textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight)}px`;
                }}
                onFocus={() => {
                  window.parent.postMessage({ type: 'EXPAND_WIDGET' }, '*');
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    if (message.trim() && !isLoading) {
                      sendMessage();
                      if (inputRef.current) {
                        inputRef.current.style.height = isMobileDevice ? '48px' : '44px';
                      }
                    }
                  }
                }}
                readOnly={isLoading}
                rows={2}
                className="w-full px-3 sm:px-4 py-2 sm:py-3 pr-12 sm:pr-14 rounded-xl sm:rounded-2xl border border-gray-200 bg-white placeholder:text-gray-400 focus:outline-none focus:border-purple-400 focus:ring-1 focus:ring-purple-400 resize-none text-sm sm:text-base"
                style={{ 
                  fontSize: isMobileDevice ? '16px' : '15px',
                  WebkitAppearance: 'none',
                  appearance: 'none',
                  minHeight: isMobileDevice ? '48px' : '44px',
                  maxHeight: '120px',
                  lineHeight: '1.4'
                }}
              />
              <button
                type="submit"
                disabled={isLoading || !message.trim()}
                className="absolute right-2 sm:right-3 top-1/2 -translate-y-1/2 h-8 w-8 sm:h-9 sm:w-9 rounded-full flex-shrink-0 disabled:opacity-40 flex items-center justify-center transition-all duration-200 hover:scale-105"
                style={{ 
                  background: message.trim() ? `linear-gradient(135deg, ${chatColor}, ${chatColorEnd})` : '#e5e7eb',
                  border: 'none',
                  cursor: isLoading || !message.trim() ? 'not-allowed' : 'pointer',
                  boxShadow: message.trim() ? '0 2px 8px rgba(0,0,0,0.15)' : 'none'
                }}
                data-send-button
              >
                {isLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin text-white" />
                ) : (
                  <Send className={`w-4 h-4 ${message.trim() ? 'text-white' : 'text-gray-400'}`} />
                )}
              </button>
            </div>
          </form>
          
          {/* Image search button - below input field (only shown when visual search is enabled) */}
          {settings?.visualSearchEnabled && (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isLoading || isUploadingImage}
              className="mt-2 flex items-center justify-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 disabled:opacity-50 transition-colors w-full py-1"
              style={{ cursor: isLoading ? 'not-allowed' : 'pointer' }}
            >
              <Camera className="w-3.5 h-3.5" />
              <span>Upload image to find similar products</span>
            </button>
          )}
          {settings?.jobPortalEnabled && (
            <>
              <input
                ref={resumeInputRef}
                type="file"
                accept="application/pdf"
                onChange={handleResumeSelect}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => resumeInputRef.current?.click()}
                disabled={isLoading}
                className="mt-2 flex items-center justify-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 disabled:opacity-50 transition-colors w-full py-1"
                style={{ cursor: isLoading ? 'not-allowed' : 'pointer' }}
              >
                <Briefcase className="w-3.5 h-3.5" />
                <span>Upload Resume (PDF)</span>
              </button>
            </>
          )}
          {(settings?.footerLabelEnabled === "true" || settings?.poweredByEnabled !== "false") && (
            <p className="text-center pt-1 pb-1 px-3 flex items-center justify-center gap-1.5 flex-wrap" style={{ fontSize: '10px', color: '#b0b0b0' }}>
              {settings?.footerLabelEnabled === "true" && settings?.footerLabelText && (
                <span>{settings.footerLabelText}</span>
              )}
              {settings?.footerLabelEnabled === "true" && settings?.footerLabelText && settings?.poweredByEnabled !== "false" && (
                <span>·</span>
              )}
              {settings?.poweredByEnabled !== "false" && (
                <span>
                  Powered by{' '}
                  <a
                    href="https://aichroney.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: '#9333ea', textDecoration: 'none', fontWeight: 500 }}
                  >
                    AI Chroney
                  </a>
                </span>
              )}
            </p>
          )}
          </>
          )}
        </div>
      )}

      {/* Fallback message for voice-only mode with voice disabled */}
      {settings?.chatMode === 'voice-only' && !settings?.voiceModeEnabled && (
        <div className="border-t border-gray-200 p-6 bg-white flex-shrink-0 text-center">
          <div className="flex flex-col items-center gap-3">
            <Mic className="w-12 h-12 text-gray-300" />
            <p className="text-sm text-gray-500">Voice mode is currently unavailable</p>
            <p className="text-xs text-gray-400">Please contact support for assistance</p>
          </div>
        </div>
      )}

      {/* Image Lightbox Modal */}
      {expandedImageUrl && (
        <div 
          className="fixed inset-0 z-[99999] bg-black/80 flex items-center justify-center p-4"
          onClick={() => setExpandedImageUrl(null)}
        >
          <div className="relative max-w-full max-h-full">
            <button
              onClick={() => setExpandedImageUrl(null)}
              className="absolute -top-3 -right-3 w-8 h-8 bg-white rounded-full flex items-center justify-center shadow-lg hover:bg-gray-100 transition-colors z-10"
            >
              <X className="w-5 h-5 text-gray-700" />
            </button>
            <img 
              src={expandedImageUrl} 
              alt="Expanded view" 
              className="max-w-full max-h-[80vh] object-contain rounded-lg shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        </div>
      )}

      {/* Image Crop Overlay for Visual Search */}
      <AnimatePresence>
        {showCropOverlay && pendingSearchImageUrl && (
          <ChatImageCropOverlay
            imageUrl={pendingSearchImageUrl}
            onSearch={(boundingBox) => {
              performVisualSearch(pendingSearchImageUrl, boundingBox);
            }}
            onSearchFullImage={() => {
              performVisualSearch(pendingSearchImageUrl);
            }}
            onCancel={() => {
              setShowCropOverlay(false);
              setPendingSearchImageUrl(null);
            }}
            isSearching={isLoading}
            accentColor={chatColor}
          />
        )}
      </AnimatePresence>

      {/* Virtual Try-On Overlay */}
      <AnimatePresence>
        {showTryOnOverlay && tryOnProduct && businessAccountId && (
          <TryOnOverlay
            productImage={tryOnProduct.imageUrl}
            productName={tryOnProduct.name}
            productType={tryOnProduct.type}
            businessAccountId={businessAccountId}
            onClose={() => {
              setShowTryOnOverlay(false);
              setTryOnProduct(null);
            }}
            onResult={(resultImageUrl) => {
              // Add try-on result as a chat message
              const tryOnMessage = {
                id: `tryon-${Date.now()}`,
                role: 'assistant' as const,
                content: `Here's how ${tryOnProduct.name} looks on you!`,
                tryOnResult: resultImageUrl,
                timestamp: new Date()
              };
              setMessages(prev => [...prev, tryOnMessage]);
            }}
            accentColor={chatColor}
          />
        )}
      </AnimatePresence>


      {/* Conversation History Panel */}
      <AnimatePresence>
        {isHistoryPanelOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-50 bg-black/50"
            onClick={() => setIsHistoryPanelOpen(false)}
          >
            <motion.div
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 300 }}
              className="absolute right-0 top-0 h-full w-full max-w-sm bg-white shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Panel Header */}
              <div 
                className="flex items-center gap-3 px-4 py-3 text-white"
                style={{ background: `linear-gradient(to right, ${chatColor}, ${chatColorEnd})` }}
              >
                <button
                  onClick={() => setIsHistoryPanelOpen(false)}
                  className="p-1 rounded-full hover:bg-white/20 transition-colors"
                >
                  <ChevronLeft className="w-5 h-5" />
                </button>
                <h3 className="font-semibold text-base flex-1">Conversation History</h3>
              </div>

              {/* Conversations List */}
              <div className="flex-1 overflow-y-auto" style={{ maxHeight: 'calc(100vh - 60px)' }}>
                {isLoadingConversations ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                  </div>
                ) : conversationsList.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
                    <History className="w-12 h-12 text-gray-300 mb-3" />
                    <p className="text-gray-500 text-sm">No previous conversations</p>
                    <p className="text-gray-400 text-xs mt-1">Your chat history will appear here</p>
                  </div>
                ) : (
                  <div className="divide-y divide-gray-100">
                    {conversationsList.map((conv) => (
                      <button
                        key={conv.id}
                        onClick={() => handleLoadConversation(conv.id)}
                        className="w-full px-4 py-3 text-left hover:bg-gray-50 transition-colors"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-gray-800 text-sm truncate">
                              {conv.title || 'Conversation'}
                            </p>
                            <p className="text-xs text-gray-500 mt-0.5">
                              {conv.messageCount} messages
                            </p>
                          </div>
                          <span className="text-xs text-gray-400 whitespace-nowrap">
                            {new Date(conv.updatedAt).toLocaleDateString()}
                          </span>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      
      {/* Urgency offer renders on parent page via postMessage, not inside iframe */}

      {/* Floating Compare Button - Show when products are selected for comparison */}
      {settings?.productComparisonEnabled === 'true' && compareProducts.size > 0 && (
        <button
          onClick={() => setShowComparisonView(true)}
          className="fixed bottom-24 right-4 flex items-center gap-2 px-4 py-2 text-white rounded-full shadow-lg transition-all duration-200 hover:scale-105 z-40"
          style={{ background: `linear-gradient(135deg, ${chatColor}, ${chatColorEnd})` }}
        >
          <GitCompare className="w-4 h-4" />
          Compare ({compareProducts.size})
        </button>
      )}

      {/* Product Comparison View */}
      {showComparisonView && (
        <Suspense fallback={<LazyLoadingFallback />}>
          <ProductComparisonView
            products={allProducts.filter(p => compareProducts.has(p.id))}
            currencySymbol={currencySymbol}
            onRemove={(productId) => {
              setCompareProducts(prev => {
                const next = new Set(prev);
                next.delete(productId);
                return next;
              });
            }}
            onClose={() => setShowComparisonView(false)}
            chatColor={chatColor}
            whatsappNumber={settings?.whatsappOrderEnabled === 'true' ? settings?.whatsappOrderNumber : undefined}
            whatsappMessage={settings?.whatsappOrderMessage}
          />
        </Suspense>
      )}
    </div>
  );
}
