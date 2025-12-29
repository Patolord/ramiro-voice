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

      // Load audio worklet for processing
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
                // Send chunks periodically
                if (this.buffer.length >= 4096) {
                  this.port.postMessage(new Int16Array(this.buffer));
                  this.buffer = [];
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

      // Connect to AssemblyAI WebSocket
      const ws = new WebSocket(
        `wss://api.assemblyai.com/v2/realtime/ws?sample_rate=${SAMPLE_RATE}&token=${token}`
      );
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

        // Send audio data
        workletNode.port.onmessage = (event) => {
          if (ws.readyState === WebSocket.OPEN) {
            // Convert Int16Array to base64
            const int16Array = event.data as Int16Array;
            const uint8Array = new Uint8Array(int16Array.buffer);
            const base64 = btoa(String.fromCharCode(...uint8Array));
            ws.send(JSON.stringify({ audio_data: base64 }));
          }
        };
      };

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        
        if (data.message_type === "FinalTranscript" && data.text) {
          fullTranscript += (fullTranscript ? " " : "") + data.text;
          setLiveTranscript(fullTranscript);
          
          // Save to database periodically
          appendTranscription({ recordingId, text: fullTranscript });
        } else if (data.message_type === "PartialTranscript" && data.text) {
          // Show partial results (in progress)
          setLiveTranscript(fullTranscript + (fullTranscript ? " " : "") + data.text);
        }
      };

      ws.onerror = (err) => {
        console.error("WebSocket error:", err);
        setError("Connection error. Please try again.");
        cleanup();
        setStatus("idle");
      };

      ws.onclose = () => {
        console.log("WebSocket closed");
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

    // Send termination message
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ terminate_session: true }));
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
                {status === "recording" ? "live transcription" : "transcription"}
              </span>
              {status === "recording" && (
                <span className="flex items-center gap-2 text-xs text-red-400">
                  <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
                  live
                </span>
              )}
            </div>
            
            <p className="text-sm leading-relaxed whitespace-pre-wrap opacity-80 max-h-64 overflow-y-auto">
              {liveTranscript || (
                <span className="opacity-40 italic">Listening...</span>
              )}
            </p>
          </div>
        )}

        {/* Current Recording Details */}
        {currentRecording && currentRecording.status === "completed" && (
          <div className="mb-8 p-4 border border-neutral-800 rounded-lg">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm opacity-70">{currentRecording.title}</span>
              <span className="text-xs px-2 py-1 rounded bg-green-900 text-green-300">
                completed
              </span>
            </div>
            <p className="text-xs opacity-50 mb-2">
              Duration: {formatDuration(currentRecording.duration)}
            </p>
            {currentRecording.transcription && (
              <p className="text-sm leading-relaxed whitespace-pre-wrap opacity-80 max-h-48 overflow-y-auto">
                {currentRecording.transcription}
              </p>
            )}
          </div>
        )}

        {/* Past Recordings */}
        {recordings && recordings.length > 0 && (
          <div className="space-y-2">
            <h2 className="text-sm opacity-50 mb-3">past recordings</h2>
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
