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
  const [keywords, setKeywords] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [micLevel, setMicLevel] = useState(0);
  const [isListening, setIsListening] = useState(false);
  const [environmentStatus, setEnvironmentStatus] = useState<
    "quiet" | "noisy" | "very_noisy"
  >("quiet");
  const [reconnectAttempts, setReconnectAttempts] = useState(0);
  const [lastActivity, setLastActivity] = useState<number>(Date.now());

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const summarizerRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const microphoneRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const animationRef = useRef<number | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const activityCheckRef = useRef<NodeJS.Timeout | null>(null);

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

        // 음성 인식 안정성 및 성능 향상을 위한 설정
        if ("maxAlternatives" in recognition) {
          (recognition as any).maxAlternatives = 3;
        }
        if ("serviceURI" in recognition) {
          (recognition as any).serviceURI =
            "wss://www.google.com/speech-api/full-duplex/v1/up";
        }
        // 긴 발화 처리를 위한 추가 설정

        recognition.onresult = (event: SpeechRecognitionEvent) => {
          // 활동 시간 업데이트
          setLastActivity(Date.now());
          setReconnectAttempts(0);

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
          console.log("음성 인식 오류:", event.error, event.message);

          // 일시적 오류인 경우 재시도
          if (
            event.error === "network" ||
            event.error === "audio-capture" ||
            event.error === "aborted"
          ) {
            setReconnectAttempts((prev) => prev + 1);
            if (reconnectAttempts < 5) {
              // 최대 5회 재시도
              setError(
                `연결 문제 발생, 재시도 중... (${reconnectAttempts + 1}/5)`
              );
              // 지수 백오프로 재시도 간격 증가
              const delay = Math.min(
                1000 * Math.pow(2, reconnectAttempts),
                10000
              );
              reconnectTimeoutRef.current = setTimeout(() => {
                if (isRecording && recognitionRef.current) {
                  try {
                    recognitionRef.current.start();
                  } catch (err) {
                    console.log("재시도 실패:", err);
                  }
                }
              }, delay);
              return;
            }
          }

          setError(
            `음성 인식 오류: ${event.error} - ${
              event.message || "알 수 없는 오류"
            }`
          );
          if (
            event.error === "not-allowed" ||
            event.error === "service-not-allowed"
          ) {
            setIsRecording(false);
          }
        };

        recognition.onend = () => {
          setIsListening(false);

          // 녹음 중이었다면 자동으로 재시작 (연결이 끊어진 경우)
          if (isRecording) {
            const timeSinceLastActivity = Date.now() - lastActivity;

            // 최근 활동이 있었거나 재연결 시도가 5회 미만인 경우에만 재시작
            if (timeSinceLastActivity < 30000 && reconnectAttempts < 5) {
              const delay = Math.min(500 + reconnectAttempts * 200, 2000);

              reconnectTimeoutRef.current = setTimeout(() => {
                if (recognitionRef.current && isRecording) {
                  try {
                    recognitionRef.current.start();
                    setIsListening(true);
                  } catch (err) {
                    console.log("재시작 시도 중 오류:", err);
                    setReconnectAttempts((prev) => prev + 1);
                  }
                }
              }, delay);
            } else {
              setError("음성 인식이 중단되었습니다. 다시 시작해주세요.");
              setIsRecording(false);
            }
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
      cleanupReconnection();
    };
  }, []);

  // 활동 모니터링 (30초마다 체크)
  useEffect(() => {
    if (isRecording) {
      activityCheckRef.current = setInterval(() => {
        const timeSinceLastActivity = Date.now() - lastActivity;

        // 30초 이상 활동이 없으면 경고
        if (timeSinceLastActivity > 30000) {
          console.log("장시간 비활성 상태 감지");
          setError("음성 인식이 비활성 상태입니다. 말씀해 주세요.");
        }

        // 60초 이상 활동이 없으면 재시작 시도
        if (timeSinceLastActivity > 60000 && reconnectAttempts < 3) {
          console.log("장시간 비활성으로 인한 재시작 시도");
          if (recognitionRef.current) {
            try {
              recognitionRef.current.stop();
              setTimeout(() => {
                if (recognitionRef.current && isRecording) {
                  recognitionRef.current.start();
                  setLastActivity(Date.now());
                }
              }, 1000);
            } catch (err) {
              console.log("비활성 재시작 실패:", err);
            }
          }
        }
      }, 10000); // 10초마다 체크
    } else {
      if (activityCheckRef.current) {
        clearInterval(activityCheckRef.current);
        activityCheckRef.current = null;
      }
    }

    return () => {
      if (activityCheckRef.current) {
        clearInterval(activityCheckRef.current);
        activityCheckRef.current = null;
      }
    };
  }, [isRecording, lastActivity, reconnectAttempts]);

  // 요약 모델 초기화 (한국어 지원 개선)
  useEffect(() => {
    const initSummarizer = async () => {
      try {
        setIsLoading(true);
        // 다국어 지원이 더 나은 모델로 변경
        const summarizer = await pipeline(
          "summarization",
          "Xenova/mbart-large-50-many-to-many-mmt"
        );
        summarizerRef.current = summarizer;
        setIsLoading(false);
      } catch (err) {
        console.error("요약 모델 로딩 실패:", err);
        // 대안 모델로 시도
        try {
          const fallbackSummarizer = await pipeline(
            "summarization",
            "Xenova/distilbart-cnn-6-6"
          );
          summarizerRef.current = fallbackSummarizer;
          setIsLoading(false);
        } catch (fallbackErr) {
          console.error("대안 모델도 로딩 실패:", fallbackErr);
          setError("요약 모델을 로딩하는데 실패했습니다.");
          setIsLoading(false);
        }
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

  // 재연결 관련 정리
  const cleanupReconnection = () => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (activityCheckRef.current) {
      clearInterval(activityCheckRef.current);
      activityCheckRef.current = null;
    }
  };

  const startRecording = async () => {
    if (recognitionRef.current && !isRecording) {
      setError("");
      setIsRecording(true);
      setReconnectAttempts(0);
      setLastActivity(Date.now());

      // 이전 타이머들 정리
      cleanupReconnection();

      // 마이크 모니터링 시작
      await setupMicrophoneMonitoring();

      try {
        recognitionRef.current.start();
      } catch (err) {
        console.error("음성 인식 시작 오류:", err);
        setError("음성 인식을 시작할 수 없습니다. 잠시 후 다시 시도해주세요.");
        setIsRecording(false);
        cleanupMicrophoneMonitoring();
        cleanupReconnection();
      }
    }
  };

  const stopRecording = () => {
    if (recognitionRef.current && isRecording) {
      recognitionRef.current.stop();
      setIsRecording(false);
      setIsListening(false);
      setReconnectAttempts(0);

      // 모든 모니터링 정리
      cleanupMicrophoneMonitoring();
      cleanupReconnection();
    }
  };

  // 한국어 키워드 추출 함수
  const extractKeywords = (text: string): string[] => {
    // 한국어 불용어 목록
    const stopWords = new Set([
      "그",
      "이",
      "저",
      "것",
      "들",
      "의",
      "가",
      "을",
      "를",
      "에",
      "와",
      "과",
      "도",
      "는",
      "은",
      "이다",
      "있다",
      "없다",
      "하다",
      "되다",
      "이것",
      "저것",
      "그것",
      "여기",
      "저기",
      "거기",
      "이곳",
      "저곳",
      "그곳",
      "때문",
      "따라",
      "그래서",
      "그러나",
      "하지만",
      "그리고",
      "또한",
      "또는",
      "만약",
      "만일",
      "아니",
      "않",
      "못",
      "안",
      "임시",
      "최종",
      "결과",
      "내용",
      "발표",
      "음성",
      "인식",
      "요약",
      "텍스트",
    ]);

    // 텍스트 전처리
    const cleanText = text
      .replace(/\[임시\].*?(?=\s|$)/g, "")
      .replace(/[^\w\s가-힣]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    // 단어 빈도 계산
    const words = cleanText.split(/\s+/);
    const wordFreq: { [key: string]: number } = {};

    words.forEach((word) => {
      if (word.length >= 2 && !stopWords.has(word)) {
        wordFreq[word] = (wordFreq[word] || 0) + 1;
      }
    });

    // 빈도순으로 정렬하여 상위 키워드 추출
    const sortedWords = Object.entries(wordFreq)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 8)
      .map(([word]) => word);

    return sortedWords;
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

      // 텍스트 전처리 및 길이 제한
      const maxLength = 1000;
      let processedText = transcription
        .replace(/\[임시\].*?(?=\s|$)/g, "") // 임시 텍스트 제거
        .replace(/\s+/g, " ") // 연속 공백 정리
        .trim();

      // 키워드 추출
      const extractedKeywords = extractKeywords(processedText);
      setKeywords(extractedKeywords);

      const textToSummarize =
        processedText.length > maxLength
          ? processedText.substring(0, maxLength) + "..."
          : processedText;

      // 한국어 요약을 위한 개선된 설정
      const inputLength = textToSummarize.length;
      // 압축률을 50-70%로 조정 (기존 75-87%에서 개선)
      const dynamicMaxLength = Math.min(Math.max(inputLength * 0.5, 80), 300);
      const dynamicMinLength = Math.max(Math.min(inputLength * 0.3, 40), 30);

      let summaryResult;

      try {
        // 한국어 처리를 위한 설정
        summaryResult = await summarizerRef.current(textToSummarize, {
          max_length: Math.round(dynamicMaxLength),
          min_length: Math.round(dynamicMinLength),
          do_sample: false,
          repetition_penalty: 1.1,
          length_penalty: 0.8,
          // 한국어 처리 개선을 위한 추가 설정
          early_stopping: true,
          num_beams: 4,
        });
      } catch (modelError) {
        console.warn("고급 모델 실패, 기본 요약 시도:", modelError);
        // 모델이 실패하면 간단한 추출적 요약 사용
        summaryResult = [
          { summary_text: createExtractiveSummary(processedText) },
        ];
      }

      setSummary(summaryResult[0].summary_text);
      setIsLoading(false);
    } catch (err) {
      console.error("요약 실패:", err);
      setError("텍스트 요약에 실패했습니다.");
      setIsLoading(false);
    }
  };

  // 추출적 요약 (백업용)
  const createExtractiveSummary = (text: string): string => {
    const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 10);
    if (sentences.length <= 3) return text;

    // 문장 점수 계산 (길이와 키워드 포함도 기준)
    const keywords = extractKeywords(text);
    const scoredSentences = sentences.map((sentence) => {
      const keywordCount = keywords.filter((keyword) =>
        sentence.includes(keyword)
      ).length;
      return {
        sentence: sentence.trim(),
        score: keywordCount + sentence.length / 100,
      };
    });

    // 상위 문장들 선택
    const topSentences = scoredSentences
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(2, Math.ceil(sentences.length * 0.4)))
      .map((item) => item.sentence);

    return topSentences.join(". ") + ".";
  };

  const downloadAsText = () => {
    const keywordsText =
      keywords.length > 0 ? `\n\n[핵심 키워드]\n${keywords.join(", ")}` : "";
    const content = `=== 발표 음성 인식 결과 ===\n\n[원본 텍스트]\n${transcription}\n\n[요약]\n${summary}${keywordsText}\n\n생성일시: ${new Date().toLocaleString(
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
    setKeywords([]);
    setError("");
    setReconnectAttempts(0);
    setLastActivity(Date.now());
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
                    ? "음성 인식 중..."
                    : reconnectAttempts > 0
                    ? `재연결 중... (${reconnectAttempts}/5)`
                    : "연결 중..."
                  : "대기 중"}
              </span>
              {reconnectAttempts > 0 && isRecording && (
                <span className="text-xs text-orange-600">
                  연결 안정성 개선 중
                </span>
              )}
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
          <div className="flex justify-between items-center mb-2">
            <h2 className="text-xl font-semibold text-gray-700">
              📋 AI 요약 결과
            </h2>
            {summary && (
              <div className="text-xs text-gray-500 flex gap-4">
                <span>
                  원본:{" "}
                  {
                    transcription.replace(/\[임시\].*?(?=\s|$)/g, "").trim()
                      .length
                  }
                  자
                </span>
                <span>요약: {summary.length}자</span>
                <span>
                  압축률:{" "}
                  {Math.round(
                    (1 -
                      summary.length /
                        transcription.replace(/\[임시\].*?(?=\s|$)/g, "").trim()
                          .length) *
                      100
                  )}
                  %
                </span>
              </div>
            )}
          </div>
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 min-h-[120px]">
            {summary ? (
              <div>
                <p className="text-gray-800 leading-relaxed mb-3">{summary}</p>
                <div className="text-xs text-gray-500 border-t pt-2">
                  <span className="bg-blue-100 text-blue-700 px-2 py-1 rounded-full">
                    🤖 한국어 최적화 요약 시스템
                  </span>
                </div>
              </div>
            ) : (
              <div className="text-center">
                <p className="text-gray-500 italic mb-2">
                  요약 결과가 여기에 표시됩니다...
                </p>
                <p className="text-xs text-gray-400">
                  💡 한국어 처리에 최적화된 요약으로 핵심 내용을 보존합니다
                </p>
              </div>
            )}
          </div>
        </div>

        {/* 핵심 키워드 */}
        {keywords.length > 0 && (
          <div className="mb-6">
            <h2 className="text-xl font-semibold text-gray-700 mb-2">
              🔑 핵심 키워드
            </h2>
            <div className="bg-green-50 border border-green-200 rounded-lg p-4">
              <div className="flex flex-wrap gap-2">
                {keywords.map((keyword, index) => (
                  <span
                    key={index}
                    className="bg-green-100 text-green-800 px-3 py-1 rounded-full text-sm font-medium"
                  >
                    #{keyword}
                  </span>
                ))}
              </div>
              <div className="text-xs text-gray-500 mt-2 border-t pt-2">
                <span className="bg-green-100 text-green-700 px-2 py-1 rounded-full">
                  📊 빈도 기반 키워드 추출
                </span>
              </div>
            </div>
          </div>
        )}

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
      </div>
    </div>
  );
}
