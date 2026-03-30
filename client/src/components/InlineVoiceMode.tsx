import { Mic, MicOff, X, Loader2 } from "lucide-react";
import { useState, useEffect, useRef, useCallback } from "react";
import { useToast } from "@/hooks/use-toast";
import { motion, AnimatePresence } from "framer-motion";

type VoiceState = 'idle' | 'listening' | 'thinking' | 'speaking';

interface InlineVoiceModeProps {
  isActive: boolean;
  onClose: () => void;
  userId: string;
  businessAccountId: string;
  chatColor?: string;
  chatColorEnd?: string;
  avatarType?: string;
  avatarUrl?: string;
  selectedLanguage?: string;
  textConversationId?: string;
  onUserMessage?: (text: string) => void;
  onTranscriptCorrection?: (original: string, corrected: string) => void;
  onAIMessageStart?: (messageId: string) => void;
  onAIMessageChunk?: (messageId: string, text: string) => void;
  onAIMessageDone?: (messageId: string) => void;
}

export function InlineVoiceMode({
  isActive,
  onClose,
  userId,
  businessAccountId,
  textConversationId,
  chatColor = "#9333ea",
  chatColorEnd = "#3b82f6",
  avatarType = "none",
  avatarUrl,
  selectedLanguage,
  onUserMessage,
  onTranscriptCorrection,
  onAIMessageStart,
  onAIMessageChunk,
  onAIMessageDone,
}: InlineVoiceModeProps) {
  const [state, setState] = useState<VoiceState>('idle');
  const [currentTranscript, setCurrentTranscript] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [isOnline, setIsOnline] = useState(true);
  const [audioVolume, setAudioVolume] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioQueueRef = useRef<AudioBuffer[]>([]);
  const isPlayingRef = useRef(false);
  const currentAudioSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const nextPlaybackTimeRef = useRef<number>(0);
  const outboundAudioQueueRef = useRef<ArrayBuffer[]>([]);
  const maxOutboundQueueSize = 100;
  const isPausedDueToBackpressureRef = useRef(false);
  const backpressureWarningShownRef = useRef(false);
  const shouldAutoRestartRef = useRef(false);
  const isOnlineRef = useRef(true);
  const hasPermissionRef = useRef(false);
  const stateRef = useRef(state);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const audioWorkletNodeRef = useRef<AudioWorkletNode | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const resampleFractionalPositionRef = useRef<number>(0);
  const resampleLastSampleRef = useRef<number>(0);
  const vadAnalyserRef = useRef<AnalyserNode | null>(null);
  const vadIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const pendingInterruptRef = useRef(false);
  const playbackAnalyserRef = useRef<AnalyserNode | null>(null);
  const volumeIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const conversationIdRef = useRef<string | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const maxReconnectAttempts = 5;
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const heartbeatTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const busyResumeTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const sessionClosedByServerRef = useRef(false);
  const currentAIMessageIdRef = useRef<string | null>(null);
  const awaitingUserTranscriptRef = useRef(false);
  const lastAIMessageIdRef = useRef<string | null>(null);
  const bufferedTranscriptRef = useRef<{text: string, isFinal: boolean} | null>(null);
  const aiDoneReceivedRef = useRef(false);

  const { toast } = useToast();

  const safeSend = useCallback((data: string | ArrayBuffer) => {
    try {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return false;
      wsRef.current.send(data);
      return true;
    } catch (error) {
      console.error('[InlineVoice] Error sending:', error);
      return false;
    }
  }, []);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    if (isActive && !audioContextRef.current) {
      try {
        audioContextRef.current = new AudioContext({ sampleRate: 24000 });
      } catch (error) {
        console.error('[InlineVoice] Failed to preload AudioContext:', error);
      }
    }
  }, [isActive]);

  useEffect(() => {
    if (!isActive) return;
    connectWebSocket();

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          safeSend(JSON.stringify({ type: 'pong' }));
        } else if (shouldAutoRestartRef.current && conversationIdRef.current) {
          connectWebSocket();
        }
      }
    };

    const handleOnline = () => {
      if (shouldAutoRestartRef.current && conversationIdRef.current) {
        if (!wsRef.current || wsRef.current.readyState === WebSocket.CLOSED) {
          connectWebSocket();
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('online', handleOnline);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('online', handleOnline);
      cleanup();
    };
  }, [isActive, userId, businessAccountId, selectedLanguage]);

  const startHeartbeatMonitoring = () => {
    if (heartbeatTimeoutRef.current) clearTimeout(heartbeatTimeoutRef.current);
    heartbeatTimeoutRef.current = setTimeout(() => {
      console.warn('[InlineVoice] Heartbeat timeout');
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    }, 120000);
  };

  const connectWebSocket = () => {
    if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
      return;
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    setIsConnecting(true);
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    let wsUrl = `${protocol}//${host}/ws/voice?businessAccountId=${businessAccountId}&userId=${userId}`;
    if (conversationIdRef.current) {
      wsUrl += `&conversationId=${conversationIdRef.current}`;
    }
    if (textConversationId && !conversationIdRef.current) {
      wsUrl += `&textConversationId=${encodeURIComponent(textConversationId)}`;
    }
    if (selectedLanguage) {
      wsUrl += `&language=${encodeURIComponent(selectedLanguage)}`;
    }

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnecting(false);
      setIsOnline(true);
      isOnlineRef.current = true;
      reconnectAttemptsRef.current = 0;
      startHeartbeatMonitoring();
    };

    ws.onmessage = async (event) => {
      if (event.data instanceof Blob) {
        const arrayBuffer = await event.data.arrayBuffer();
        await handleAudioChunk(arrayBuffer);
      } else {
        try {
          const data = JSON.parse(event.data);
          handleMessage(data);
        } catch (error) {
          console.error('[InlineVoice] Failed to parse message:', error);
        }
      }
    };

    ws.onerror = () => {
      setIsConnecting(false);
      setIsOnline(false);
      isOnlineRef.current = false;
    };

    ws.onclose = () => {
      setIsOnline(false);
      isOnlineRef.current = false;
      setIsConnecting(false);
      if (heartbeatTimeoutRef.current) {
        clearTimeout(heartbeatTimeoutRef.current);
        heartbeatTimeoutRef.current = null;
      }
      if (sessionClosedByServerRef.current) return;
      if (shouldAutoRestartRef.current && reconnectAttemptsRef.current < maxReconnectAttempts) {
        const delay = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current), 10000);
        reconnectAttemptsRef.current++;
        reconnectTimeoutRef.current = setTimeout(() => connectWebSocket(), delay);
      }
    };
  };

  const handleMessage = async (data: any) => {
    switch (data.type) {
      case 'ready':
        if (data.conversationId) conversationIdRef.current = data.conversationId;
        sessionClosedByServerRef.current = false;
        aiDoneReceivedRef.current = false;
        if (data.reconnected && outboundAudioQueueRef.current.length > 0) {
          while (outboundAudioQueueRef.current.length > 0) {
            const chunk = outboundAudioQueueRef.current.shift()!;
            if (!safeSend(chunk)) {
              outboundAudioQueueRef.current.unshift(chunk);
              break;
            }
          }
        }
        shouldAutoRestartRef.current = true;
        if (hasPermissionRef.current) {
          try { await startRecording(); } catch (error) { setState('idle'); }
        } else {
          setState('idle');
        }
        break;

      case 'ping':
        safeSend(JSON.stringify({ type: 'pong' }));
        startHeartbeatMonitoring();
        break;

      case 'speech_started':
        if (stateRef.current === 'speaking' || isPlayingRef.current || audioQueueRef.current.length > 0) {
          handleInterruption();
        }
        break;

      case 'transcript':
        if (pendingInterruptRef.current && data.isFinal) {
          pendingInterruptRef.current = false;
          bufferedTranscriptRef.current = null;
        }
        if (data.isFinal) {
          onUserMessage?.(data.text);
          awaitingUserTranscriptRef.current = false;
          lastAIMessageIdRef.current = null;
          setCurrentTranscript('');
          setState('thinking');
        } else {
          setCurrentTranscript(data.text);
        }
        break;

      case 'transcript_correction':
        onTranscriptCorrection?.(data.original, data.corrected);
        break;

      case 'ai_chunk':
        if (pendingInterruptRef.current && !currentAIMessageIdRef.current) {
          pendingInterruptRef.current = false;
        }
        if (pendingInterruptRef.current) return;

        setState('speaking');
        if (!vadIntervalRef.current && mediaStreamRef.current) {
          startVoiceActivityDetection();
        }

        if (!currentAIMessageIdRef.current) {
          const messageId = 'voice-ai-' + Date.now().toString();
          currentAIMessageIdRef.current = messageId;
          awaitingUserTranscriptRef.current = true;
          onAIMessageStart?.(messageId);
          onAIMessageChunk?.(messageId, data.text);
        } else {
          onAIMessageChunk?.(currentAIMessageIdRef.current, data.text);
        }
        break;

      case 'ai_speaking':
        setState('speaking');
        const msgId = 'voice-ai-' + Date.now().toString();
        onAIMessageStart?.(msgId);
        onAIMessageChunk?.(msgId, data.text);
        onAIMessageDone?.(msgId);
        break;

      case 'ai_done':
        if (pendingInterruptRef.current) return;
        if (isPlayingRef.current || audioQueueRef.current.length > 0) {
          aiDoneReceivedRef.current = true;
        } else {
          processAiDone();
        }
        break;

      case 'interrupt_ack':
        pendingInterruptRef.current = false;
        currentAIMessageIdRef.current = null;
        if (bufferedTranscriptRef.current) {
          onUserMessage?.(bufferedTranscriptRef.current.text);
          bufferedTranscriptRef.current = null;
          setState('thinking');
        } else {
          setState('listening');
        }
        break;

      case 'busy':
        aiDoneReceivedRef.current = false;
        setState('idle');
        setCurrentTranscript('');
        stopRecording();
        if (busyResumeTimeoutRef.current) clearTimeout(busyResumeTimeoutRef.current);
        busyResumeTimeoutRef.current = setTimeout(async () => {
          if (isOnlineRef.current && hasPermissionRef.current) {
            try { await startRecording(); setState('listening'); } catch {}
          }
        }, 5000);
        break;

      case 'session_closed':
        aiDoneReceivedRef.current = false;
        sessionClosedByServerRef.current = true;
        conversationIdRef.current = null;
        setState('idle');
        stopRecording();
        toast({
          title: "Session Ended",
          description: "Tap the mic to start a new conversation.",
          duration: 5000,
        });
        break;

      case 'error':
        aiDoneReceivedRef.current = false;
        toast({ title: "Error", description: data.message || "Voice processing error", variant: "destructive" });
        setState('idle');
        stopRecording();
        break;
    }
  };

  const handleAudioChunk = async (arrayBuffer: ArrayBuffer) => {
    try {
      if (!audioContextRef.current) {
        audioContextRef.current = new AudioContext({ sampleRate: 24000 });
      }
      const actualSampleRate = audioContextRef.current.sampleRate;
      const sourceSampleRate = 24000;
      const pcm16Data = new Int16Array(arrayBuffer);
      const float32Data = new Float32Array(pcm16Data.length);
      for (let i = 0; i < pcm16Data.length; i++) {
        float32Data[i] = pcm16Data[i] / (pcm16Data[i] < 0 ? 32768 : 32767);
      }
      let resampledData = float32Data;
      if (actualSampleRate !== sourceSampleRate) {
        const resampleRatio = actualSampleRate / sourceSampleRate;
        const outputLength = Math.floor(float32Data.length * resampleRatio);
        resampledData = new Float32Array(outputLength);
        for (let i = 0; i < outputLength; i++) {
          const position = i / resampleRatio;
          const index = Math.floor(position);
          const fraction = position - index;
          const y0 = float32Data[Math.max(0, index - 1)] || 0;
          const y1 = float32Data[index] || 0;
          const y2 = float32Data[Math.min(float32Data.length - 1, index + 1)] || 0;
          const y3 = float32Data[Math.min(float32Data.length - 1, index + 2)] || 0;
          const a0 = -0.5 * y0 + 1.5 * y1 - 1.5 * y2 + 0.5 * y3;
          const a1 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
          const a2 = -0.5 * y0 + 0.5 * y2;
          const a3 = y1;
          const t = fraction;
          resampledData[i] = Math.max(-1, Math.min(1, a0 * t * t * t + a1 * t * t + a2 * t + a3));
        }
      }
      const audioBuffer = audioContextRef.current.createBuffer(1, resampledData.length, actualSampleRate);
      audioBuffer.getChannelData(0).set(resampledData);
      audioQueueRef.current.push(audioBuffer);
      if (!isPlayingRef.current) playNextAudioChunk();
    } catch (error) {
      console.error('[InlineVoice] Audio chunk error:', error);
    }
  };

  const startVolumeMonitoring = () => {
    if (volumeIntervalRef.current) return;
    volumeIntervalRef.current = setInterval(() => {
      if (!playbackAnalyserRef.current) return;
      const dataArray = new Uint8Array(playbackAnalyserRef.current.frequencyBinCount);
      playbackAnalyserRef.current.getByteFrequencyData(dataArray);
      const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
      setAudioVolume(Math.min(100, (average / 255) * 150));
    }, 50);
  };

  const stopVolumeMonitoring = () => {
    if (volumeIntervalRef.current) {
      clearInterval(volumeIntervalRef.current);
      volumeIntervalRef.current = null;
    }
    setAudioVolume(0);
  };

  const startVoiceActivityDetection = () => {
    if (!mediaSourceRef.current || !audioContextRef.current || vadIntervalRef.current) return;
    try {
      const analyser = audioContextRef.current.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.3;
      mediaSourceRef.current.connect(analyser);
      vadAnalyserRef.current = analyser;
      const dataArray = new Float32Array(analyser.frequencyBinCount);
      let consecutiveSpeechFrames = 0;
      const speechThreshold = 0.015;
      const requiredFrames = 3;

      vadIntervalRef.current = setInterval(() => {
        if (!vadAnalyserRef.current) return;
        vadAnalyserRef.current.getFloatTimeDomainData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i] * dataArray[i];
        const rms = Math.sqrt(sum / dataArray.length);
        if (rms > speechThreshold) {
          consecutiveSpeechFrames++;
          if (consecutiveSpeechFrames >= requiredFrames && stateRef.current === 'speaking') {
            handleInterruption();
          }
        } else {
          consecutiveSpeechFrames = 0;
        }
      }, 100);
    } catch (error) {
      console.error('[InlineVoice] VAD setup failed:', error);
    }
  };

  const stopVoiceActivityDetection = () => {
    if (vadIntervalRef.current) {
      clearInterval(vadIntervalRef.current);
      vadIntervalRef.current = null;
    }
    if (vadAnalyserRef.current) {
      try { vadAnalyserRef.current.disconnect(); } catch {}
      vadAnalyserRef.current = null;
    }
  };

  const handleInterruption = () => {
    pendingInterruptRef.current = true;
    aiDoneReceivedRef.current = false;
    if (currentAIMessageIdRef.current) {
      onAIMessageDone?.(currentAIMessageIdRef.current);
      currentAIMessageIdRef.current = null;
    }
    bufferedTranscriptRef.current = null;
    stopVoiceActivityDetection();
    stopVolumeMonitoring();
    if (currentAudioSourceRef.current) {
      try { currentAudioSourceRef.current.stop(); } catch {}
      currentAudioSourceRef.current = null;
    }
    audioQueueRef.current = [];
    isPlayingRef.current = false;
    nextPlaybackTimeRef.current = 0;
    if (playbackAnalyserRef.current) {
      try { playbackAnalyserRef.current.disconnect(); } catch {}
      playbackAnalyserRef.current = null;
    }
    safeSend(JSON.stringify({ type: 'interrupt' }));
    setState('listening');
  };

  const processAiDone = () => {
    aiDoneReceivedRef.current = false;
    if (pendingInterruptRef.current) return;
    if (currentAIMessageIdRef.current) {
      onAIMessageDone?.(currentAIMessageIdRef.current);
      if (awaitingUserTranscriptRef.current) {
        lastAIMessageIdRef.current = currentAIMessageIdRef.current;
      }
    }
    currentAIMessageIdRef.current = null;
    stopVoiceActivityDetection();
    if (shouldAutoRestartRef.current && isOnlineRef.current && hasPermissionRef.current) {
      setState('listening');
    } else {
      setState('idle');
    }
  };

  const playNextAudioChunk = () => {
    if (pendingInterruptRef.current) {
      isPlayingRef.current = false;
      currentAudioSourceRef.current = null;
      audioQueueRef.current = [];
      return;
    }
    if (audioQueueRef.current.length === 0) {
      isPlayingRef.current = false;
      currentAudioSourceRef.current = null;
      stopVolumeMonitoring();
      if (playbackAnalyserRef.current) {
        try { playbackAnalyserRef.current.disconnect(); } catch {}
        playbackAnalyserRef.current = null;
      }
      if (aiDoneReceivedRef.current) {
        processAiDone();
      }
      return;
    }
    isPlayingRef.current = true;
    const audioBuffer = audioQueueRef.current.shift()!;
    if (!audioContextRef.current) return;
    const source = audioContextRef.current.createBufferSource();
    source.buffer = audioBuffer;
    if (!playbackAnalyserRef.current) {
      playbackAnalyserRef.current = audioContextRef.current.createAnalyser();
      playbackAnalyserRef.current.fftSize = 256;
      playbackAnalyserRef.current.smoothingTimeConstant = 0.8;
      startVolumeMonitoring();
    }
    source.connect(playbackAnalyserRef.current);
    playbackAnalyserRef.current.connect(audioContextRef.current.destination);
    currentAudioSourceRef.current = source;
    const currentTime = audioContextRef.current.currentTime;
    const scheduleTime = Math.max(currentTime, nextPlaybackTimeRef.current);
    source.onended = () => {
      currentAudioSourceRef.current = null;
      playNextAudioChunk();
    };
    source.start(scheduleTime);
    nextPlaybackTimeRef.current = scheduleTime + audioBuffer.duration;
  };

  const float32ToInt16 = (float32Array: Float32Array): Int16Array => {
    const int16Array = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return int16Array;
  };

  const startRecording = async () => {
    try {
      if (audioWorkletNodeRef.current || scriptProcessorRef.current) return;
      resampleFractionalPositionRef.current = 0;
      resampleLastSampleRef.current = 0;

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: 24000, channelCount: 1 }
      });
      hasPermissionRef.current = true;
      mediaStreamRef.current = stream;

      if (!audioContextRef.current) {
        audioContextRef.current = new AudioContext({ sampleRate: 24000 });
      }
      const actualSampleRate = audioContextRef.current.sampleRate;
      const source = audioContextRef.current.createMediaStreamSource(stream);
      mediaSourceRef.current = source;

      if (stateRef.current === 'speaking' && !vadIntervalRef.current) {
        startVoiceActivityDetection();
      }

      let workletLoaded = false;
      if (audioContextRef.current.audioWorklet) {
        try {
          await audioContextRef.current.audioWorklet.addModule('/audio-processor.js');
          workletLoaded = true;
        } catch {}
      }

      if (workletLoaded && audioContextRef.current.audioWorklet) {
        const workletNode = new AudioWorkletNode(audioContextRef.current, 'pcm16-audio-processor', {
          processorOptions: { sampleRate: actualSampleRate }
        });
        audioWorkletNodeRef.current = workletNode;
        workletNode.port.onmessage = (event) => {
          if (event.data.type === 'audio') {
            const queueSize = outboundAudioQueueRef.current.length;
            if (queueSize >= maxOutboundQueueSize * 0.8) {
              if (!isPausedDueToBackpressureRef.current) {
                isPausedDueToBackpressureRef.current = true;
              }
              return;
            }
            if (queueSize < maxOutboundQueueSize * 0.5 && isPausedDueToBackpressureRef.current) {
              isPausedDueToBackpressureRef.current = false;
              backpressureWarningShownRef.current = false;
            }
            if (!isPausedDueToBackpressureRef.current) {
              outboundAudioQueueRef.current.push(event.data.data);
              while (outboundAudioQueueRef.current.length > 0) {
                const chunk = outboundAudioQueueRef.current.shift()!;
                if (!safeSend(chunk)) {
                  outboundAudioQueueRef.current.unshift(chunk);
                  break;
                }
              }
            }
          }
        };
        source.connect(workletNode);
      } else {
        const bufferSize = 2048;
        const processor = audioContextRef.current.createScriptProcessor(bufferSize, 1, 1);
        scriptProcessorRef.current = processor;
        processor.onaudioprocess = (event) => {
          const inputData = event.inputBuffer.getChannelData(0);
          let resampledData: Float32Array = inputData;
          if (actualSampleRate !== 24000) {
            const resampleRatio = actualSampleRate / 24000;
            const output: number[] = [];
            let position = resampleFractionalPositionRef.current;
            while (true) {
              const index = Math.floor(position);
              const fraction = position - index;
              if (index >= inputData.length) break;
              let sample;
              if (index + 1 < inputData.length) {
                sample = inputData[index] * (1 - fraction) + inputData[index + 1] * fraction;
              } else {
                sample = inputData[index] * (1 - fraction) + resampleLastSampleRef.current * fraction;
              }
              output.push(sample);
              position += resampleRatio;
            }
            if (inputData.length > 0) resampleLastSampleRef.current = inputData[inputData.length - 1];
            resampleFractionalPositionRef.current = position - inputData.length;
            resampledData = new Float32Array(output);
          }
          const pcm16Data = float32ToInt16(resampledData);
          const queueSize = outboundAudioQueueRef.current.length;
          if (queueSize >= maxOutboundQueueSize * 0.8) {
            if (!isPausedDueToBackpressureRef.current) isPausedDueToBackpressureRef.current = true;
            return;
          }
          if (queueSize < maxOutboundQueueSize * 0.5 && isPausedDueToBackpressureRef.current) {
            isPausedDueToBackpressureRef.current = false;
            backpressureWarningShownRef.current = false;
          }
          if (!isPausedDueToBackpressureRef.current) {
            outboundAudioQueueRef.current.push(pcm16Data.buffer);
            while (outboundAudioQueueRef.current.length > 0) {
              const chunk = outboundAudioQueueRef.current.shift()!;
              if (!safeSend(chunk)) {
                outboundAudioQueueRef.current.unshift(chunk);
                break;
              }
            }
          }
        };
        source.connect(processor);
      }
      setState('listening');
    } catch (error: any) {
      hasPermissionRef.current = false;
      setState('idle');
      if (error.name === 'NotAllowedError') {
        toast({ title: "Microphone Access Denied", description: "Please enable microphone in your browser settings.", variant: "destructive" });
      } else {
        toast({ title: "Microphone Error", description: "Could not access microphone.", variant: "destructive" });
      }
    }
  };

  const stopRecording = (): Promise<void> => {
    return new Promise((resolve) => {
      try {
        if (audioWorkletNodeRef.current) {
          audioWorkletNodeRef.current.disconnect();
          audioWorkletNodeRef.current.port.onmessage = null;
          audioWorkletNodeRef.current = null;
        }
        if (scriptProcessorRef.current) {
          scriptProcessorRef.current.disconnect();
          scriptProcessorRef.current.onaudioprocess = null;
          scriptProcessorRef.current = null;
        }
        if (mediaSourceRef.current) {
          mediaSourceRef.current.disconnect();
          mediaSourceRef.current = null;
        }
        if (mediaStreamRef.current) {
          mediaStreamRef.current.getTracks().forEach(track => track.stop());
          mediaStreamRef.current = null;
        }
        resolve();
      } catch {
        audioWorkletNodeRef.current = null;
        scriptProcessorRef.current = null;
        mediaSourceRef.current = null;
        if (mediaStreamRef.current) {
          mediaStreamRef.current.getTracks().forEach(track => track.stop());
          mediaStreamRef.current = null;
        }
        resolve();
      }
    });
  };

  const cleanup = () => {
    shouldAutoRestartRef.current = false;
    if (currentAIMessageIdRef.current) {
      onAIMessageDone?.(currentAIMessageIdRef.current);
      currentAIMessageIdRef.current = null;
    }
    try {
      if (reconnectTimeoutRef.current) { clearTimeout(reconnectTimeoutRef.current); reconnectTimeoutRef.current = null; }
      if (heartbeatTimeoutRef.current) { clearTimeout(heartbeatTimeoutRef.current); heartbeatTimeoutRef.current = null; }
      if (busyResumeTimeoutRef.current) { clearTimeout(busyResumeTimeoutRef.current); busyResumeTimeoutRef.current = null; }
      stopVoiceActivityDetection();
      stopVolumeMonitoring();
      if (currentAudioSourceRef.current) { try { currentAudioSourceRef.current.stop(); } catch {} currentAudioSourceRef.current = null; }
      if (playbackAnalyserRef.current) { try { playbackAnalyserRef.current.disconnect(); } catch {} playbackAnalyserRef.current = null; }
      audioQueueRef.current = [];
      outboundAudioQueueRef.current = [];
      isPlayingRef.current = false;
      nextPlaybackTimeRef.current = 0;
      stopRecording();
      if (wsRef.current) {
        if (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING) wsRef.current.close();
        wsRef.current = null;
      }
      if (audioContextRef.current) {
        if (audioContextRef.current.state !== 'closed') audioContextRef.current.close().catch(() => {});
        audioContextRef.current = null;
      }
      setState('idle');
      setCurrentTranscript('');
      setIsOnline(false);
      isOnlineRef.current = false;
      setIsConnecting(false);
      conversationIdRef.current = null;
      reconnectAttemptsRef.current = 0;
    } catch (error) {
      console.error('[InlineVoice] Cleanup error:', error);
    }
  };

  const handleClose = () => {
    cleanup();
    onClose();
  };

  if (!isActive) return null;

  const avatarSrc = avatarType === 'custom' ? (avatarUrl || '') :
    avatarType && avatarType !== 'none' ? `/avatars/avatar-${avatarType.replace('preset-', '')}.png` : '';

  const stateLabel = state === 'listening' ? (currentTranscript || 'Listening...') :
    state === 'thinking' ? 'Thinking...' :
    state === 'speaking' ? 'Speaking...' :
    isConnecting ? 'Connecting...' : 'Tap to start';

  return (
    <div className="flex items-center gap-3 px-3 py-2 min-h-[56px]">
      <button
        onClick={handleClose}
        className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center hover:bg-gray-200 transition-colors"
        aria-label="Exit voice mode"
      >
        <X className="w-4 h-4 text-gray-500" />
      </button>

      <div className="flex-1 flex items-center gap-3 min-w-0">
        <button
          onClick={async () => {
            if (state === 'idle' && isOnline && !isConnecting) {
              shouldAutoRestartRef.current = true;
              try { await startRecording(); } catch {}
            }
          }}
          className="relative flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center overflow-hidden transition-transform"
          style={{ background: `linear-gradient(135deg, ${chatColor}, ${chatColorEnd})` }}
          aria-label="Voice control"
        >
          <AnimatePresence mode="wait">
            {state === 'listening' && (
              <>
                {[0, 1, 2].map((i) => (
                  <motion.div
                    key={`wave-${i}`}
                    className="absolute inset-0 rounded-full border border-white/40"
                    initial={{ scale: 1, opacity: 0.6 }}
                    animate={{ scale: [1, 1.6], opacity: [0.6, 0] }}
                    transition={{ duration: 1.5, repeat: Infinity, delay: i * 0.4, ease: "easeOut" }}
                  />
                ))}
              </>
            )}
            {state === 'speaking' && (
              <>
                {[0, 1, 2, 3].map((i) => (
                  <motion.div
                    key={`speak-${i}`}
                    className="absolute inset-0 rounded-full border border-white/50"
                    initial={{ scale: 1, opacity: 0.5 }}
                    animate={{ scale: [1, 2], opacity: [0.5, 0] }}
                    transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.3, ease: "easeOut" }}
                  />
                ))}
              </>
            )}
            {state === 'thinking' && (
              <motion.div
                className="absolute inset-0 rounded-full border-2 border-white/30"
                animate={{ rotate: 360 }}
                transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
              />
            )}
          </AnimatePresence>

          {avatarSrc ? (
            <img src={avatarSrc} alt="AI" className="w-full h-full object-cover rounded-full relative z-10" />
          ) : (
            <Mic className="w-5 h-5 text-white relative z-10" />
          )}
        </button>

        <div className="flex-1 min-w-0">
          {state === 'listening' && currentTranscript ? (
            <p className="text-sm text-gray-700 truncate">{currentTranscript}</p>
          ) : (
            <div className="flex items-center gap-2">
              {state === 'listening' && (
                <div className="flex items-center gap-0.5">
                  {[0, 1, 2, 3, 4].map((i) => (
                    <motion.div
                      key={i}
                      className="w-0.5 rounded-full"
                      style={{ backgroundColor: chatColor }}
                      animate={{ height: ['4px', `${8 + Math.random() * 12}px`, '4px'] }}
                      transition={{ duration: 0.6 + Math.random() * 0.4, repeat: Infinity, delay: i * 0.1 }}
                    />
                  ))}
                </div>
              )}
              {state === 'speaking' && (
                <div className="flex items-center gap-0.5">
                  {[0, 1, 2, 3, 4, 5, 6].map((i) => (
                    <motion.div
                      key={i}
                      className="w-0.5 rounded-full"
                      style={{ backgroundColor: chatColor }}
                      animate={{
                        height: [`${3 + audioVolume * 0.1}px`, `${6 + audioVolume * 0.2 + Math.random() * 8}px`, `${3 + audioVolume * 0.1}px`]
                      }}
                      transition={{ duration: 0.3 + Math.random() * 0.3, repeat: Infinity, delay: i * 0.05 }}
                    />
                  ))}
                </div>
              )}
              {state === 'thinking' && <Loader2 className="w-4 h-4 animate-spin" style={{ color: chatColor }} />}
              <span className="text-sm text-gray-500">{stateLabel}</span>
            </div>
          )}
        </div>
      </div>

    </div>
  );
}
