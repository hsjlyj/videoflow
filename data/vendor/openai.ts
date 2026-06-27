/**
 * Toonflow AI供应商模板
 * @version 2.0
 */
// ============================================================
// 类型定义
// ============================================================
type VideoMode =
  | "singleImage"
  | "startEndRequired"
  | "endFrameOptional"
  | "startFrameOptional"
  | "text"
  | (`videoReference:${number}` | `imageReference:${number}` | `audioReference:${number}`)[];
interface TextModel {
  name: string;
  modelName: string;
  type: "text";
  think: boolean;
}
interface ImageModel {
  name: string;
  modelName: string;
  type: "image";
  mode: ("text" | "singleImage" | "multiReference")[];
  associationSkills?: string;
}
interface VideoModel {
  name: string;
  modelName: string;
  type: "video";
  mode: VideoMode[];
  associationSkills?: string;
  audio: "optional" | false | true;
  durationResolutionMap: { duration: number[]; resolution: string[] }[];
}
interface TTSModel {
  name: string;
  modelName: string;
  type: "tts";
  voices: { title: string; voice: string }[];
}
interface VendorConfig {
  id: string;
  version: string;
  name: string;
  author: string;
  description?: string;
  icon?: string;
  inputs: { key: string; label: string; type: "text" | "password" | "url"; required: boolean; placeholder?: string }[];
  inputValues: Record<string, string>;
  models: (TextModel | ImageModel | VideoModel | TTSModel)[];
}
interface ImageConfig {
  prompt: string;
  imageBase64: string[];
  size: "1K" | "2K" | "4K";
  aspectRatio: `${number}:${number}`;
}
interface VideoConfig {
  duration: number;
  resolution: string;
  aspectRatio: "16:9" | "9:16";
  prompt: string;
  imageBase64?: string[];
  audio?: boolean;
  mode: VideoMode[];
}
interface TTSConfig {
  text: string;
  voice: string;
  speechRate: number;
  pitchRate: number;
  volume: number;
}
interface PollResult {
  completed: boolean;
  data?: string;
  error?: string;
}
// ============================================================
// 全局声明
// ============================================================
declare const axios: any;
declare const logger: (msg: string) => void;
declare const jsonwebtoken: any;
declare const zipImage: (base64: string, size: number) => Promise<string>;
declare const zipImageResolution: (base64: string, w: number, h: number) => Promise<string>;
declare const mergeImages: (base64Arr: string[], maxSize?: string) => Promise<string>;
declare const urlToBase64: (url: string) => Promise<string>;
declare const pollTask: (fn: () => Promise<PollResult>, interval?: number, timeout?: number) => Promise<PollResult>;
declare const createOpenAI: any;
declare const createDeepSeek: any;
declare const createZhipu: any;
declare const createQwen: any;
declare const createAnthropic: any;
declare const createOpenAICompatible: any;
declare const createXai: any;
declare const createMinimax: any;
declare const createGoogleGenerativeAI: any;
declare const exports: {
  vendor: VendorConfig;
  textRequest: (m: TextModel, t: boolean, tl: 0 | 1 | 2 | 3) => any;
  imageRequest: (c: ImageConfig, m: ImageModel) => Promise<string>;
  videoRequest: (c: VideoConfig, m: VideoModel) => Promise<string>;
  ttsRequest: (c: TTSConfig, m: TTSModel) => Promise<string>;
  checkForUpdates?: () => Promise<{ hasUpdate: boolean; latestVersion: string; notice: string }>;
  updateVendor?: () => Promise<string>;
};
// ============================================================
// 供应商配置
// ============================================================
const vendor: VendorConfig = {
  id: "openai",
  version: "2.0",
  author: "Toonflow",
  name: "OpenAI标准接口",
  description: "OpenAI标准格式接口，可修改请求地址并手动添加模型。",
  icon: "",
  inputs: [
    { key: "apiKey", label: "API密钥", type: "password", required: true },
    { key: "baseUrl", label: "请求地址", type: "url", required: true, placeholder: "以v1结束，示例：https://api.openai.com/v1" },
  ],
  inputValues: {
    apiKey: "",
    baseUrl: "https://api.openai.com/v1",
  },
  models: [
    { name: "GPT-4o", modelName: "gpt-4o", type: "text", think: false },
    { name: "GPT-4.1", modelName: "gpt-4.1", type: "text", think: false },
    { name: "GPT-5.1", modelName: "gpt-5.1", type: "text", think: false },
    { name: "GPT-5.2", modelName: "gpt-5.2", type: "text", think: false },
    { name: "GPT-5.4", modelName: "gpt-5.4", type: "text", think: false },
  ],
};
// ============================================================
// 适配器函数
// ============================================================
const textRequest = (model: TextModel, think: boolean, thinkLevel: 0 | 1 | 2 | 3) => {
  if (!vendor.inputValues.apiKey) throw new Error("缺少API Key");
  const apiKey = vendor.inputValues.apiKey.replace(/^Bearer\s+/i, "");
  return createOpenAI({ baseURL: vendor.inputValues.baseUrl, apiKey }).chat(model.modelName);
};
const imageRequest = async (config: ImageConfig, model: ImageModel): Promise<string> => {
  if (!vendor.inputValues.apiKey) throw new Error("缺少API Key");
  const apiKey = vendor.inputValues.apiKey.replace(/^Bearer\s+/i, "");
  const baseUrl = vendor.inputValues.baseUrl.replace(/\/$/, "");
  const imageBase64List = (config.imageBase64 ?? []).filter(Boolean);
  const sizeMap: Record<string, Record<string, string>> = {
    "1:1": { "1K": "1024x1024", "2K": "1536x1536", "4K": "2048x2048" },
    "16:9": { "1K": "1792x1024", "2K": "1536x864", "4K": "2048x1152" },
    "9:16": { "1K": "1024x1792", "2K": "864x1536", "4K": "1152x2048" },
  };
  const requestSize = sizeMap[config.aspectRatio]?.[config.size] || sizeMap["1:1"][config.size] || "1024x1024";
  const body: Record<string, any> = {
    model: model.modelName,
    prompt: config.prompt,
    size: requestSize,
    response_format: "b64_json",
  };
  if (imageBase64List.length === 1) body.image = imageBase64List[0];
  if (imageBase64List.length > 1) body.images = imageBase64List;
  const response = await fetch(`${baseUrl}/images/generations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`图片生成失败: ${errorText}`);
  }
  const data = await response.json();
  const item = data?.data?.[0] || data?.images?.[0] || data?.result?.[0] || data;
  if (item?.b64_json) return item.b64_json;
  if (item?.url) return await urlToBase64(item.url);
  if (data?.url) return await urlToBase64(data.url);
  throw new Error("图片生成失败：未返回有效图片结果");
};
const videoRequest = async (config: VideoConfig, model: VideoModel): Promise<string> => {
  if (!vendor.inputValues.apiKey) throw new Error("缺少API Key");
  const apiKey = vendor.inputValues.apiKey.replace(/^Bearer\s+/i, "");
  const baseUrl = vendor.inputValues.baseUrl.replace(/\/$/, "");
  const imageBase64List = (config.imageBase64 ?? []).filter(Boolean);
  const requestSize = config.aspectRatio === "9:16" ? "720x1280" : "1280x720";
  const metadata: Record<string, any> = {
    aspect_ratio: config.aspectRatio,
    resolution: config.resolution,
    audio: config.audio ?? false,
  };
  if (imageBase64List[0]) {
    metadata.img_url = imageBase64List[0];
    metadata.first_frame_url = imageBase64List[0];
  }
  if (imageBase64List[1]) {
    metadata.image_tail = imageBase64List[1];
    metadata.last_frame_url = imageBase64List[1];
  }
  const createWithOpenAIVideos = async () => {
    const body: Record<string, any> = {
      model: model.modelName,
      prompt: config.prompt,
      seconds: String(config.duration),
      size: requestSize,
      metadata,
    };
    if (imageBase64List[0]) body.image = imageBase64List[0];
    const response = await fetch(`${baseUrl}/videos`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(errorText);
    }
    const data = await response.json();
    const videoId = data?.id || data?.video_id || data?.task_id;
    if (!videoId) throw new Error("视频任务创建失败：未返回视频ID");
    const result = await pollTask(async () => {
      const queryResponse = await fetch(`${baseUrl}/videos/${videoId}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": "Mozilla/5.0" },
      });
      if (!queryResponse.ok) {
        const errorText = await queryResponse.text();
        throw new Error(`查询视频任务状态失败: ${errorText}`);
      }
      const queryData = await queryResponse.json();
      const status = queryData?.status;
      if (status === "succeeded" || status === "completed") {
        if (queryData?.url) return { completed: true, data: queryData.url };
        return { completed: true, data: `__content__:${videoId}` };
      }
      if (status === "failed" || status === "cancelled" || status === "expired") {
        return { completed: true, error: queryData?.error?.message || queryData?.message || "视频生成失败" };
      }
      return { completed: false };
    }, 10000, 600000);
    if (result.error) throw new Error(result.error);
    if (result.data?.startsWith("__content__:")) {
      const contentResponse = await fetch(`${baseUrl}/videos/${videoId}/content`, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": "Mozilla/5.0" },
      });
      if (!contentResponse.ok) {
        const errorText = await contentResponse.text();
        throw new Error(`下载视频内容失败: ${errorText}`);
      }
      const buffer = Buffer.from(await contentResponse.arrayBuffer());
      return buffer.toString("base64");
    }
    return await urlToBase64(result.data!);
  };
  const createWithNewApi = async () => {
    const body: Record<string, any> = {
      model: model.modelName,
      prompt: config.prompt,
      duration: config.duration,
      width: config.aspectRatio === "9:16" ? 720 : 1280,
      height: config.aspectRatio === "9:16" ? 1280 : 720,
      image: imageBase64List[0],
      metadata,
    };
    const response = await fetch(`${baseUrl}/video/generations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(errorText);
    }
    const data = await response.json();
    const taskId = data?.task_id || data?.id;
    if (!taskId) throw new Error("视频任务创建失败：未返回任务ID");
    const result = await pollTask(async () => {
      const queryResponse = await fetch(`${baseUrl}/video/generations/${taskId}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": "Mozilla/5.0" },
      });
      if (!queryResponse.ok) {
        const errorText = await queryResponse.text();
        throw new Error(`查询视频任务状态失败: ${errorText}`);
      }
      const queryData = await queryResponse.json();
      const status = queryData?.status;
      if (status === "succeeded" || status === "completed") {
        if (queryData?.url) return { completed: true, data: queryData.url };
        return { completed: true, error: "任务成功但未返回视频URL" };
      }
      if (status === "failed" || status === "cancelled" || status === "expired") {
        return { completed: true, error: queryData?.error?.message || queryData?.message || "视频生成失败" };
      }
      return { completed: false };
    }, 10000, 600000);
    if (result.error) throw new Error(result.error);
    return await urlToBase64(result.data!);
  };
  try {
    return await createWithOpenAIVideos();
  } catch (e: any) {
    const message = String(e?.message || e || "");
    if (message.includes("Invalid URL") || message.includes("invalid_json") || message.includes("fail_to_fetch_task") || message.includes("账号授权已失效")) {
      return await createWithNewApi();
    }
    throw e;
  }
};
const ttsRequest = async (config: TTSConfig, model: TTSModel): Promise<string> => {
  if (!vendor.inputValues.apiKey) throw new Error("缺少API Key");
  const apiKey = vendor.inputValues.apiKey.replace(/^Bearer\s+/i, "");
  const baseUrl = vendor.inputValues.baseUrl.replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/audio/speech`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0",
    },
    body: JSON.stringify({
      model: model.modelName,
      input: config.text,
      voice: config.voice,
      format: "mp3",
    }),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`语音生成失败: ${errorText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  return buffer.toString("base64");
};
const checkForUpdates = async (): Promise<{ hasUpdate: boolean; latestVersion: string; notice: string }> => {
  return { hasUpdate: false, latestVersion: "2.0", notice: "" };
};
const updateVendor = async (): Promise<string> => {
  return "";
};
// ============================================================
// 导出
// ============================================================
exports.vendor = vendor;
exports.textRequest = textRequest;
exports.imageRequest = imageRequest;
exports.videoRequest = videoRequest;
exports.ttsRequest = ttsRequest;
exports.checkForUpdates = checkForUpdates;
exports.updateVendor = updateVendor;
export {};