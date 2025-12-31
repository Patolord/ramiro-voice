"use client";

import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { useState, useRef, useEffect, useCallback } from "react";
import { Id } from "../convex/_generated/dataModel";

type RecordingStatus = "idle" | "connecting" | "recording";

const SAMPLE_RATE = 16000;

export default function Home() {
  const [status, setStatus] = useState<RecordingStatus>("idle");
  const [duration, setDuration] = useState(0);
  const [liveTranscript, setLiveTranscript] = useState("");
  const [currentRecordingId, setCurrentRecordingId] = useState<Id<"recordings"> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const startTimeRef = useRef<number>(0);

  const getStreamingToken = useAction(api.streaming.getStreamingToken);
  const createRecording = useMutation(api.recordings.createRecording);
  const appendTranscription = useMutation(api.recordings.appendTranscription);
  const finishRecording = useMutation(api.recordings.finishRecording);
  const recordings = useQuery(api.recordings.listRecordings);
  const currentRecording = useQuery(
    api.recordings.getRecording,
    currentRecordingId ? { recordingId: currentRecordingId } : "skip"
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanup();
    };
  }, []);

  const cleanup = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (workletNodeRef.current) {
      workletNodeRef.current.disconnect();
      workletNodeRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  }, []);

  const formatDuration = (seconds: number) => {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    if (hrs > 0) {
      return `${hrs}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
    }
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const startRecording = async () => {
    setError(null);
    setStatus("connecting");
    
    try {
      // Get streaming token
      const { token } = await getStreamingToken();
      
      // Create recording entry
      const timestamp = new Date().toLocaleString();
      const recordingId = await createRecording({ title: `Meeting ${timestamp}` });
      setCurrentRecordingId(recordingId);
      setLiveTranscript("");

      // Get microphone access
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          sampleRate: SAMPLE_RATE,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        } 
      });
      streamRef.current = stream;

      // Set up Web Audio API for processing
      const audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
      audioContextRef.current = audioContext;

      // Load audio worklet for processing - sends ~50ms chunks (800 samples at 16kHz)
      await audioContext.audioWorklet.addModule(
        URL.createObjectURL(new Blob([`
          class PCMProcessor extends AudioWorkletProcessor {
            constructor() {
              super();
              this.buffer = [];
            }
            
            process(inputs) {
              const input = inputs[0];
              if (input.length > 0) {
                const samples = input[0];
                // Convert float32 to int16
                for (let i = 0; i < samples.length; i++) {
                  const s = Math.max(-1, Math.min(1, samples[i]));
                  this.buffer.push(s < 0 ? s * 0x8000 : s * 0x7FFF);
                }
                // Send ~50ms chunks (800 samples at 16kHz)
                if (this.buffer.length >= 800) {
                  const int16Array = new Int16Array(this.buffer.slice(0, 800));
                  this.port.postMessage(int16Array.buffer, [int16Array.buffer]);
                  this.buffer = this.buffer.slice(800);
                }
              }
              return true;
            }
          }
          registerProcessor('pcm-processor', PCMProcessor);
        `], { type: 'application/javascript' }))
      );

      const source = audioContext.createMediaStreamSource(stream);
      const workletNode = new AudioWorkletNode(audioContext, 'pcm-processor');
      workletNodeRef.current = workletNode;
      source.connect(workletNode);

      // Connect to AssemblyAI v3 Universal Streaming WebSocket
      // Using universal-streaming-multi for Portuguese support
      const wsUrl = new URL("wss://streaming.assemblyai.com/v3/ws");
      wsUrl.searchParams.set("sample_rate", String(SAMPLE_RATE));
      wsUrl.searchParams.set("encoding", "pcm_s16le");
      wsUrl.searchParams.set("format_turns", "true");
      wsUrl.searchParams.set("speech_model", "universal-streaming-multi");
      wsUrl.searchParams.set("token", token);
      
      const ws = new WebSocket(wsUrl.toString());
      wsRef.current = ws;

      let fullTranscript = "";

      ws.onopen = () => {
        setStatus("recording");
        startTimeRef.current = Date.now();
        
        // Start timer
        timerRef.current = setInterval(() => {
          const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
          setDuration(elapsed);
          
          // Auto-stop at 1 hour
          if (elapsed >= 3600) {
            stopRecording();
          }
        }, 1000);

        // Send audio data as raw binary
        workletNode.port.onmessage = (event) => {
          if (ws.readyState === WebSocket.OPEN) {
            // Send raw PCM binary data
            ws.send(event.data);
          }
        };
      };

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        
        // v3 API uses "Turn" events
        if (data.type === "Turn") {
          if (data.end_of_turn && data.transcript) {
            // Final transcript for this turn
            fullTranscript += (fullTranscript ? " " : "") + data.transcript;
            setLiveTranscript(fullTranscript);
            
            // Save to database
            appendTranscription({ recordingId, text: fullTranscript });
          } else if (data.transcript) {
            // Partial/in-progress transcript
            setLiveTranscript(fullTranscript + (fullTranscript ? " " : "") + data.transcript);
          }
        } else if (data.type === "Begin") {
          console.log("Session started:", data.id);
        } else if (data.type === "Termination") {
          console.log("Session terminated");
        }
      };

      ws.onerror = (err) => {
        console.error("WebSocket error:", err);
        setError("Connection error. Please try again.");
        cleanup();
        setStatus("idle");
      };

      ws.onclose = (event) => {
        console.log("WebSocket closed:", event.code, event.reason);
      };

    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Failed to start recording");
      cleanup();
      setStatus("idle");
    }
  };

  const stopRecording = async () => {
    if (status !== "recording") return;

    const finalDuration = Math.floor((Date.now() - startTimeRef.current) / 1000);

    // Send termination message (v3 format)
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "Terminate" }));
    }

    cleanup();

    // Finalize recording
    if (currentRecordingId) {
      await finishRecording({
        recordingId: currentRecordingId,
        duration: finalDuration,
        finalTranscription: liveTranscript,
      });
    }

    setStatus("idle");
    setDuration(0);
  };

  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-lg">
        <h1 className="text-2xl font-light tracking-tight mb-12 text-center opacity-80">
          meeting recorder
        </h1>

        {/* Recording Button */}
        <div className="flex flex-col items-center mb-12">
      <button
            onClick={status === "recording" ? stopRecording : startRecording}
            disabled={status === "connecting"}
            className={`
              w-32 h-32 rounded-full transition-all duration-300 flex items-center justify-center
              ${status === "recording" 
                ? "bg-red-500 hover:bg-red-600 animate-pulse" 
                : status === "connecting"
                ? "bg-neutral-600 cursor-wait"
                : "bg-neutral-800 hover:bg-neutral-700 hover:scale-105"
              }
            `}
          >
            {status === "recording" ? (
              <div className="w-8 h-8 bg-white rounded-sm" />
            ) : status === "connecting" ? (
              <div className="w-6 h-6 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : (
              <div className="w-0 h-0 border-l-[20px] border-l-white border-y-[12px] border-y-transparent ml-2" />
            )}
      </button>

          <p className="mt-6 text-4xl font-mono tracking-wider opacity-90">
            {formatDuration(duration)}
          </p>

          <p className="mt-2 text-sm opacity-50">
            {status === "idle" && "tap to record"}
            {status === "connecting" && "connecting..."}
            {status === "recording" && "recording... tap to stop"}
          </p>

          {error && (
            <p className="mt-4 text-red-400 text-sm">{error}</p>
          )}
        </div>

        {/* Live Transcription */}
        {(status === "recording" || liveTranscript) && (
          <div className="mb-8 p-4 border border-neutral-800 rounded-lg">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm opacity-70">
                {status === "recording" ? "transcrição ao vivo" : "transcrição"}
              </span>
              {status === "recording" && (
                <span className="flex items-center gap-2 text-xs text-red-400">
                  <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
                  ao vivo
              </span>
              )}
            </div>
            
            <p className="text-sm leading-relaxed whitespace-pre-wrap opacity-80 max-h-64 overflow-y-auto">
              {liveTranscript || (
                <span className="opacity-40 italic">Ouvindo...</span>
              )}
            </p>
          </div>
        )}

        {/* Current Recording Details */}
        {currentRecording && (currentRecording.status === "completed" || currentRecording.status === "processing" || currentRecording.status === "error") && (
          <div className="mb-8 p-4 border border-neutral-800 rounded-lg">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm opacity-70">{currentRecording.title}</span>
              <span className={`text-xs px-2 py-1 rounded ${
                currentRecording.status === "completed" ? "bg-green-900 text-green-300" :
                currentRecording.status === "processing" ? "bg-yellow-900 text-yellow-300" :
                "bg-red-900 text-red-300"
              }`}>
                {currentRecording.status === "completed" ? "concluído" :
                 currentRecording.status === "processing" ? "processando..." :
                 "erro"}
              </span>
            </div>
            <p className="text-xs opacity-50 mb-2">
              Duração: {formatDuration(currentRecording.duration)}
            </p>
            {currentRecording.transcription && (
              <div className="mb-4">
                <h3 className="text-xs opacity-60 mb-2">Transcrição:</h3>
                <p className="text-sm leading-relaxed whitespace-pre-wrap opacity-80 max-h-48 overflow-y-auto">
                  {currentRecording.transcription}
                </p>
              </div>
            )}
            {currentRecording.insights && (
              <div className="mt-4 pt-4 border-t border-neutral-800">
                <h3 className="text-xs opacity-60 mb-2">Insights:</h3>
                <p className="text-sm leading-relaxed whitespace-pre-wrap opacity-80 max-h-48 overflow-y-auto">
                  {currentRecording.insights}
                </p>
              </div>
            )}
            {currentRecording.status === "processing" && (
              <div className="mt-4 pt-4 border-t border-neutral-800">
                <p className="text-xs opacity-50 italic">Gerando insights...</p>
              </div>
            )}
            {currentRecording.errorMessage && (
              <div className="mt-4 pt-4 border-t border-neutral-800">
                <p className="text-xs text-red-400">{currentRecording.errorMessage}</p>
              </div>
            )}
          </div>
        )}

        {/* Past Recordings */}
        {recordings && recordings.length > 0 && (
          <div className="space-y-2">
            <h2 className="text-sm opacity-50 mb-3">gravações anteriores</h2>
            {recordings
              .filter((r: { _id: Id<"recordings"> }) => r._id !== currentRecordingId)
              .slice(0, 5)
              .map((recording: { _id: Id<"recordings">; title: string; duration: number; status: string }) => (
            <button
                  key={recording._id}
                  onClick={() => {
                    setCurrentRecordingId(recording._id);
                    setLiveTranscript("");
                  }}
                  className="w-full flex items-center justify-between p-3 bg-neutral-900 hover:bg-neutral-800 rounded-lg transition-colors text-left"
                >
                  <span className="text-sm truncate opacity-80">{recording.title}</span>
                  <div className="flex items-center gap-3">
                    <span className="text-xs opacity-50 font-mono">
                      {formatDuration(recording.duration)}
                    </span>
                    <span className={`w-2 h-2 rounded-full ${
                      recording.status === "completed" ? "bg-green-500" :
                      recording.status === "error" ? "bg-red-500" :
                      "bg-yellow-500 animate-pulse"
                    }`} />
                  </div>
            </button>
              ))}
        </div>
      )}
    </div>
    </main>
  );
}
