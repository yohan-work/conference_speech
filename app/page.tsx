"use client";

import { useState, useRef, useEffect } from "react";
import { pipeline } from "@xenova/transformers";

// 음성 인식 타입 정의
interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: (event: SpeechRecognitionEvent) => void;
  onerror: (event: SpeechRecognitionErrorEvent) => void;
  onend: () => void;
  onstart: () => void;
}

interface SpeechRecognitionEvent {
  results: SpeechRecognitionResultList;
}

interface SpeechRecognitionResultList {
  length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
  isFinal: boolean;
  length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface SpeechRecognitionErrorEvent {
  error: string;
  message: string;
}

declare global {
  interface Window {
    SpeechRecognition: new () => SpeechRecognition;
    webkitSpeechRecognition: new () => SpeechRecognition;
  }
}

export default function Home() {
  const [isRecording, setIsRecording] = useState(false);
  const [transcription, setTranscription] = useState("");
  const [summary, setSummary] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [micLevel, setMicLevel] = useState(0);
  const [isListening, setIsListening] = useState(false);
  const [environmentStatus, setEnvironmentStatus] = useState<
    "quiet" | "noisy" | "very_noisy"
  >("quiet");

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const summarizerRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const microphoneRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const animationRef = useRef<number | null>(null);

  // 음성 인식 초기화
  useEffect(() => {
    if (typeof window !== "undefined") {
      const SpeechRecognition =
        window.SpeechRecognition || window.webkitSpeechRecognition;

      if (SpeechRecognition) {
        const recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = "ko-KR";

        // 음성 인식 민감도 향상을 위한 추가 설정
        if ("maxAlternatives" in recognition) {
          (recognition as any).maxAlternatives = 1;
        }
        if ("serviceURI" in recognition) {
          (recognition as any).serviceURI =
            "wss://www.google.com/speech-api/full-duplex/v1/up";
        }

        recognition.onresult = (event: SpeechRecognitionEvent) => {
          let finalTranscript = "";
          let interimTranscript = "";

          for (let i = 0; i < event.results.length; i++) {
            const result = event.results[i];
            if (result.isFinal) {
              finalTranscript += result[0].transcript + " ";
            } else {
              interimTranscript += result[0].transcript;
            }
          }

          // 임시 결과도 실시간으로 보여주기 (더 반응성 향상)
          if (interimTranscript) {
            setTranscription((prev) => {
              // 이전 임시 결과 제거하고 새로운 임시 결과 추가
              const lastFinalIndex = prev.lastIndexOf("[최종]");
              const basePrev =
                lastFinalIndex >= 0 ? prev.substring(0, lastFinalIndex) : prev;
              return basePrev + finalTranscript + `[임시] ${interimTranscript}`;
            });
          } else if (finalTranscript) {
            setTranscription((prev) => {
              // 임시 결과 제거하고 최종 결과만 추가
              const tempIndex = prev.indexOf("[임시]");
              const basePrev =
                tempIndex >= 0 ? prev.substring(0, tempIndex) : prev;
              return basePrev + finalTranscript;
            });
          }
        };

        recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
          setError(`음성 인식 오류: ${event.error}`);
          setIsRecording(false);
        };

        recognition.onend = () => {
          // 녹음 중이었다면 자동으로 재시작 (연결이 끊어진 경우)
          if (isRecording) {
            setTimeout(() => {
              if (recognitionRef.current && isRecording) {
                try {
                  recognitionRef.current.start();
                  setIsListening(true);
                } catch (err) {
                  console.log("재시작 시도 중 오류:", err);
                }
              }
            }, 100);
          } else {
            setIsListening(false);
          }
        };

        recognition.onstart = () => {
          setIsListening(true);
        };

        recognitionRef.current = recognition;
      } else {
        setError(
          "이 브라우저는 음성 인식을 지원하지 않습니다. Chrome 브라우저를 사용해주세요."
        );
      }
    }

    // 컴포넌트 언마운트 시 정리
    return () => {
      cleanupMicrophoneMonitoring();
    };
  }, []);

  // 요약 모델 초기화
  useEffect(() => {
    const initSummarizer = async () => {
      try {
        setIsLoading(true);
        const summarizer = await pipeline(
          "summarization",
          "Xenova/distilbart-cnn-6-6"
        );
        summarizerRef.current = summarizer;
        setIsLoading(false);
      } catch (err) {
        console.error("요약 모델 로딩 실패:", err);
        setError("요약 모델을 로딩하는데 실패했습니다.");
        setIsLoading(false);
      }
    };

    initSummarizer();
  }, []);

  // 마이크 볼륨 모니터링 설정
  const setupMicrophoneMonitoring = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          // 추가 노이즈 제거 설정
          sampleRate: 44100,
          sampleSize: 16,
          channelCount: 1,
        },
      });

      const audioContext = new (window.AudioContext ||
        (window as any).webkitAudioContext)();
      const analyser = audioContext.createAnalyser();
      const microphone = audioContext.createMediaStreamSource(stream);

      analyser.fftSize = 256;
      microphone.connect(analyser);

      audioContextRef.current = audioContext;
      analyserRef.current = analyser;
      microphoneRef.current = microphone;

      // 볼륨 레벨 모니터링
      const monitorVolume = () => {
        if (analyserRef.current && isRecording) {
          const dataArray = new Uint8Array(
            analyserRef.current.frequencyBinCount
          );
          analyserRef.current.getByteFrequencyData(dataArray);

          const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
          const roundedLevel = Math.round(average);
          setMicLevel(roundedLevel);

          // 환경 소음 상태 판단
          if (roundedLevel < 10) {
            setEnvironmentStatus("quiet");
          } else if (roundedLevel < 25) {
            setEnvironmentStatus("noisy");
          } else {
            setEnvironmentStatus("very_noisy");
          }

          animationRef.current = requestAnimationFrame(monitorVolume);
        }
      };

      monitorVolume();
    } catch (err) {
      console.error("마이크 접근 오류:", err);
      setError(
        "마이크에 접근할 수 없습니다. 브라우저에서 마이크 권한을 허용해주세요."
      );
    }
  };

  // 마이크 모니터링 정리
  const cleanupMicrophoneMonitoring = () => {
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }
    if (microphoneRef.current) {
      microphoneRef.current.disconnect();
      microphoneRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    setMicLevel(0);
    setEnvironmentStatus("quiet");
  };

  const startRecording = async () => {
    if (recognitionRef.current && !isRecording) {
      setError("");
      setIsRecording(true);

      // 마이크 모니터링 시작
      await setupMicrophoneMonitoring();

      try {
        recognitionRef.current.start();
      } catch (err) {
        console.error("음성 인식 시작 오류:", err);
        setError("음성 인식을 시작할 수 없습니다. 잠시 후 다시 시도해주세요.");
        setIsRecording(false);
        cleanupMicrophoneMonitoring();
      }
    }
  };

  const stopRecording = () => {
    if (recognitionRef.current && isRecording) {
      recognitionRef.current.stop();
      setIsRecording(false);
      setIsListening(false);

      // 마이크 모니터링 정리
      cleanupMicrophoneMonitoring();
    }
  };

  const summarizeText = async () => {
    if (!transcription.trim()) {
      setError("요약할 텍스트가 없습니다.");
      return;
    }

    if (!summarizerRef.current) {
      setError("요약 모델이 아직 로딩되지 않았습니다.");
      return;
    }

    try {
      setIsLoading(true);
      setError("");

      // 텍스트가 너무 길면 잘라서 처리
      const maxLength = 1000;
      const textToSummarize =
        transcription.length > maxLength
          ? transcription.substring(0, maxLength) + "..."
          : transcription;

      const result = await summarizerRef.current(textToSummarize, {
        max_length: 150,
        min_length: 30,
        do_sample: false,
      });

      setSummary(result[0].summary_text);
      setIsLoading(false);
    } catch (err) {
      console.error("요약 실패:", err);
      setError("텍스트 요약에 실패했습니다.");
      setIsLoading(false);
    }
  };

  const downloadAsText = () => {
    const content = `=== 발표 음성 인식 결과 ===\n\n[원본 텍스트]\n${transcription}\n\n[요약]\n${summary}\n\n생성일시: ${new Date().toLocaleString(
      "ko-KR"
    )}`;

    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `발표내용_${new Date().toISOString().split("T")[0]}.txt`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const clearAll = () => {
    setTranscription("");
    setSummary("");
    setError("");
  };

  return (
    <div className="container mx-auto px-4 py-8 max-w-4xl">
      <div className="bg-white rounded-lg shadow-lg p-6">
        <h1 className="text-3xl font-bold text-center mb-8 text-gray-800">
          발표 음성 인식 & 요약
        </h1>

        {/* 에러 메시지 */}
        {error && (
          <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
            {error}
          </div>
        )}

        {/* 로딩 상태 */}
        {isLoading && (
          <div className="bg-blue-100 border border-blue-400 text-blue-700 px-4 py-3 rounded mb-4">
            모델을 로딩 중입니다... 잠시만 기다려주세요.
          </div>
        )}

        {/* 녹음 컨트롤 */}
        <div className="flex justify-center items-center gap-4 mb-8">
          <div className="flex flex-col items-center gap-2">
            <div className="flex items-center gap-2">
              {isRecording && (
                <div className="w-3 h-3 bg-red-500 rounded-full animate-pulse"></div>
              )}
              <span className="text-sm text-gray-600">
                {isRecording
                  ? isListening
                    ? "🎤 음성 인식 중..."
                    : "🔄 연결 중..."
                  : "⏸️ 대기 중"}
              </span>
            </div>

            {/* 마이크 볼륨 표시 */}
            {isRecording && (
              <div className="flex flex-col items-center gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500">볼륨:</span>
                  <div className="w-32 h-2 bg-gray-200 rounded-full overflow-hidden">
                    <div
                      className={`h-full transition-all duration-100 ${
                        micLevel > 30
                          ? "bg-green-500"
                          : micLevel > 15
                          ? "bg-yellow-500"
                          : "bg-red-400"
                      }`}
                      style={{ width: `${Math.min(micLevel * 3, 100)}%` }}
                    ></div>
                  </div>
                  <span className="text-xs text-gray-500 w-8">{micLevel}</span>
                </div>

                {/* 환경 상태 표시 */}
                <div
                  className={`text-xs px-2 py-1 rounded-full ${
                    environmentStatus === "quiet"
                      ? "bg-green-100 text-green-700"
                      : environmentStatus === "noisy"
                      ? "bg-yellow-100 text-yellow-700"
                      : "bg-red-100 text-red-700"
                  }`}
                >
                  {environmentStatus === "quiet" &&
                    "🔇 조용한 환경 (인식 최적)"}
                  {environmentStatus === "noisy" && "🔊 약간 시끄러운 환경"}
                  {environmentStatus === "very_noisy" &&
                    "📢 매우 시끄러운 환경 (인식 어려움)"}
                </div>
              </div>
            )}
          </div>

          <button
            onClick={startRecording}
            disabled={isRecording}
            className={`px-6 py-3 rounded-lg font-semibold transition-colors ${
              isRecording
                ? "bg-gray-300 text-gray-500 cursor-not-allowed"
                : "bg-green-500 hover:bg-green-600 text-white"
            }`}
          >
            🎤 녹음 시작
          </button>

          <button
            onClick={stopRecording}
            disabled={!isRecording}
            className={`px-6 py-3 rounded-lg font-semibold transition-colors ${
              !isRecording
                ? "bg-gray-300 text-gray-500 cursor-not-allowed"
                : "bg-red-500 hover:bg-red-600 text-white"
            }`}
          >
            🛑 녹음 중지
          </button>
        </div>

        {/* 원본 텍스트 */}
        <div className="mb-6">
          <div className="flex justify-between items-center mb-2">
            <h2 className="text-xl font-semibold text-gray-700">
              📝 인식된 텍스트
            </h2>
            <span className="text-sm text-gray-500">
              {transcription.length} 글자
            </span>
          </div>
          <textarea
            value={transcription}
            onChange={(e) => setTranscription(e.target.value)}
            placeholder="음성 인식 결과가 여기에 표시됩니다..."
            className="w-full h-40 p-4 border border-gray-300 rounded-lg resize-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>

        {/* 요약 버튼 */}
        <div className="flex justify-center mb-6">
          <button
            onClick={summarizeText}
            disabled={!transcription.trim() || isLoading}
            className={`px-8 py-3 rounded-lg font-semibold transition-colors ${
              !transcription.trim() || isLoading
                ? "bg-gray-300 text-gray-500 cursor-not-allowed"
                : "bg-blue-500 hover:bg-blue-600 text-white"
            }`}
          >
            ✨ 요약하기
          </button>
        </div>

        {/* 요약 결과 */}
        <div className="mb-6">
          <h2 className="text-xl font-semibold text-gray-700 mb-2">
            📋 요약 결과
          </h2>
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 min-h-[120px]">
            {summary ? (
              <p className="text-gray-800 leading-relaxed">{summary}</p>
            ) : (
              <p className="text-gray-500 italic">
                요약 결과가 여기에 표시됩니다...
              </p>
            )}
          </div>
        </div>

        {/* 액션 버튼들 */}
        <div className="flex justify-center gap-4">
          <button
            onClick={downloadAsText}
            disabled={!transcription.trim()}
            className={`px-6 py-3 rounded-lg font-semibold transition-colors ${
              !transcription.trim()
                ? "bg-gray-300 text-gray-500 cursor-not-allowed"
                : "bg-purple-500 hover:bg-purple-600 text-white"
            }`}
          >
            💾 텍스트 다운로드
          </button>

          <button
            onClick={clearAll}
            className="px-6 py-3 bg-gray-500 hover:bg-gray-600 text-white rounded-lg font-semibold transition-colors"
          >
            🗑️ 전체 삭제
          </button>
        </div>

        {/* 사용법 안내 */}
        <div className="mt-8 p-4 bg-gray-100 rounded-lg">
          <h3 className="font-semibold text-gray-700 mb-2">📖 사용법 및 팁</h3>
          <ul className="text-sm text-gray-600 space-y-1">
            <li>1. "녹음 시작" 버튼을 클릭하여 음성 인식을 시작합니다.</li>
            <li>
              2. 마이크 권한을 허용하고, 볼륨 바가 초록색이 되도록 적절한
              거리에서 말씀하세요.
            </li>
            <li>
              3. 발표 내용을 명확하게 말하면 실시간으로 텍스트가 인식됩니다.
            </li>
            <li>4. [임시] 표시는 아직 확정되지 않은 인식 결과입니다.</li>
            <li>5. "녹음 중지" 버튼으로 인식을 종료합니다.</li>
            <li>6. "요약하기" 버튼으로 AI가 내용을 요약합니다.</li>
            <li>7. "텍스트 다운로드"로 결과를 파일로 저장할 수 있습니다.</li>
          </ul>

          <div className="mt-3 p-3 bg-blue-50 rounded border-l-4 border-blue-400">
            <h4 className="font-medium text-blue-800 mb-1">
              🎯 음성 인식 개선 팁
            </h4>
            <ul className="text-xs text-blue-700 space-y-1">
              <li>
                • <strong>환경:</strong> 조용한 환경에서 사용하세요 (배경 소음
                최소화)
              </li>
              <li>
                • <strong>거리:</strong> 마이크와 30cm 정도 거리를 유지하세요
              </li>
              <li>
                • <strong>볼륨:</strong> 말할 때 볼륨 바가 초록색(30 이상)이
                되도록 하세요
              </li>
              <li>
                • <strong>속도:</strong> 너무 빠르게 말하지 마세요
              </li>
              <li>
                • <strong>발음:</strong> 명확하고 또렷하게 발음하세요
              </li>
              <li>
                • <strong>연결:</strong> 끊어져도 자동으로 재연결됩니다
              </li>
            </ul>
          </div>

          <div className="mt-3 p-3 bg-amber-50 rounded border-l-4 border-amber-400">
            <h4 className="font-medium text-amber-800 mb-1">
              ⚠️ 현재 환경이 시끄러운 경우
            </h4>
            <ul className="text-xs text-amber-700 space-y-1">
              <li>• 시끄러운 환경에서는 음성 인식 정확도가 떨어집니다</li>
              <li>• 가능하면 조용한 곳으로 이동하거나 소음을 줄여주세요</li>
              <li>• 마이크에 더 가까이 말하거나 목소리를 크게 해보세요</li>
              <li>• 발표 시작 전에 환경 상태를 확인해보세요</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
