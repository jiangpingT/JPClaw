import { log } from "../shared/logger.js";

export type VoiceWakeConfig = {
  enabled: boolean;
  keyword?: string;
  keywordPaths?: string[];
  accessKey?: string;
  onWake?: () => void | Promise<void>;
};

export class VoiceWakeService {
  private config: VoiceWakeConfig;
  private recorder: { start(): void; stop(): void } | null = null;
  private porcupine: { process: (pcm: Int16Array) => number; release: () => void } | null = null;

  constructor(config: VoiceWakeConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    if (!this.config.enabled) {
      log("info", "voicewake.disabled");
      return;
    }
    if (!this.config.accessKey) {
      log("warn", "voicewake.missing_access_key");
      return;
    }

    try {
      const { Porcupine } = await import("@picovoice/porcupine-node");
      const { PvRecorder } = await import("@picovoice/pvrecorder-node");

      const keyword = this.config.keyword || "hey pico";
      // 使用内置关键词，如果没有自定义关键词的话
      const keywordPaths = this.config.keywordPaths || ["picovoice"];
      this.porcupine = new Porcupine(
        this.config.accessKey || "",
        keywordPaths,
        keywordPaths.map(() => 0.5) // sensitivities - 为每个关键词提供敏感度值
      );

      const recorder = new PvRecorder(512);
      this.recorder = recorder;
      this.recorder.start();

      log("info", "voicewake.started", { keyword });

      while (this.recorder && this.porcupine) {
        const pcm = await recorder.read();
        const index = this.porcupine.process(pcm);
        if (index >= 0) {
          log("info", "voicewake.detected", { keyword });
          await this.config.onWake?.();
        }
      }
    } catch (error) {
      log("error", "voicewake.error", { error: String(error) });
    }
  }

  stop(): void {
    if (!this.config.enabled) return;
    this.recorder?.stop();
    this.porcupine?.release();
    log("info", "voicewake.stopped");
  }
}
