import express from "express";
import u from "@/utils";
import { z } from "zod";
import sharp from "sharp";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { Output, tool } from "ai";
import { assetItemSchema } from "@/agents/productionAgent/tools";
const router = express.Router();
export type AssetData = z.infer<typeof assetItemSchema>;

type StoryboardAssetRef = {
  assetId: number;
  name: string;
  type: string;
  imageId?: number | null;
};

type ResolvedStoryboardAssetRef = StoryboardAssetRef & {
  tokenIndex: number;
  normalizedType: "role" | "scene" | "tool" | "other";
  label: string;
  labelOrder: number;
  mentionCount: number;
  firstMention: number;
  priorityScore: number;
};

export default router.post(
  "/",
  validateFields({
    storyboardIds: z.array(z.number()),
    projectId: z.number(),
    scriptId: z.number(),
    concurrentCount: z.number().min(1).optional(),
    compulsory: z.boolean().optional(),
  }),
  async (req, res) => {
    const {
      storyboardIds,
      projectId,
      scriptId,
      concurrentCount = 5,
      compulsory = false,
    }: {
      storyboardIds: number[];
      projectId: number;
      scriptId: number;
      concurrentCount: number;
      compulsory: boolean;
    } = req.body;
    if (!storyboardIds || storyboardIds.length === 0) return res.status(400).send(error("storyboardIds不能为空"));
    let finalStoryboardIds: number[] = storyboardIds || [];
    const storyboardData = await u.db("o_storyboard").where("scriptId", scriptId).where("projectId", projectId).whereIn("id", finalStoryboardIds);
    if (!storyboardData.length) return res.status(500).send(error("未查到分镜数据"));
    const storyIds = storyboardData.map((i) => i.id);
    if (compulsory) {
      await u.db("o_storyboard").whereIn("id", storyIds).where("scriptId", scriptId).update({ state: "生成中", shouldGenerateImage: 1, reason: null });
    } else {
      await u.db("o_storyboard").whereIn("id", storyIds).where("scriptId", scriptId).where("shouldGenerateImage", 0).update({ state: "未生成" });
      await u.db("o_storyboard").whereIn("id", storyIds).where("scriptId", scriptId).where("shouldGenerateImage", 1).update({ state: "生成中", reason: null });
    }

    const projectSettingData = await u.db("o_project").where("id", projectId).select("imageModel", "imageQuality", "artStyle", "videoRatio").first();

    const assets2StoryboardRows = await u
      .db("o_assets2Storyboard")
      .whereIn("storyboardId", storyIds)
      .orderBy("rowid")
      .select("storyboardId", "assetId");

    const allAssetIds = [...new Set(assets2StoryboardRows.map((r: any) => r.assetId))];
    const assetImageMap: Record<number, number> = {};
    const assetInfoMap: Record<number, StoryboardAssetRef> = {};
    if (allAssetIds.length > 0) {
      const assetRows = await u.db("o_assets").whereIn("id", allAssetIds).select("id", "name", "type", "imageId");
      assetRows.forEach((row: any) => {
        assetImageMap[row.id] = row.imageId;
        assetInfoMap[row.id] = {
          assetId: row.id,
          name: row.name,
          type: row.type,
          imageId: row.imageId,
        };
      });
    }

    const assetRecord: Record<number, number[]> = {};
    const storyboardAssetRecord: Record<number, StoryboardAssetRef[]> = {};
    assets2StoryboardRows.forEach((item: any) => {
      if (!assetRecord[item.storyboardId]) {
        assetRecord[item.storyboardId] = [];
      }
      if (!storyboardAssetRecord[item.storyboardId]) {
        storyboardAssetRecord[item.storyboardId] = [];
      }
      const assetInfo = assetInfoMap[item.assetId];
      if (assetInfo) {
        storyboardAssetRecord[item.storyboardId].push(assetInfo);
      }
      const imageId = assetImageMap[item.assetId];
      if (imageId != null) {
        assetRecord[item.storyboardId].push(imageId);
      }
    });

    const realStoryData = await u.db("o_storyboard").where("scriptId", scriptId).where("projectId", projectId).whereIn("id", storyIds);
    res.status(200).send(
      success(
        realStoryData.map((i) => ({
          id: i.id,
          prompt: i.prompt,
          associateAssetsIds: assetRecord[i.id!],
          src: null,
          state: i.state,
          videoDesc: i.videoDesc,
          shouldGenerateImage: i.shouldGenerateImage,
        })),
      ),
    );

    const generateTask = async (item: (typeof storyboardData)[number]) => {
      const storyboardRefs = storyboardAssetRecord[item.id!] || [];
      const resolvedRefs = resolveStoryboardRefs(item.prompt!, storyboardRefs);
      const structuredPrompt = buildStoryboardReferencePrompt(item.prompt!, resolvedRefs);
      const repeloadObj = {
        prompt: structuredPrompt,
        size: projectSettingData?.imageQuality as "1K" | "2K" | "4K",
        aspectRatio: projectSettingData?.videoRatio as `${number}:${number}`,
      };
      try {
        const imageCls = await u.Ai.Image(projectSettingData?.imageModel as `${string}:${string}`).run(
          {
            referenceList: await getStoryboardReferenceList(resolvedRefs),
            ...repeloadObj,
          },
          {
            taskClass: "生成分镜图片",
            describe: "分镜图片生成",
            relatedObjects: JSON.stringify(repeloadObj),
            projectId: projectId,
          },
        );
        const savePath = `/${projectId}/assets/${scriptId}/${u.uuid()}.jpg`;
        await imageCls.save(savePath);
        await u.db("o_storyboard").where("id", item.id).update({
          filePath: savePath,
          state: "已完成",
        });
      } catch (e) {
        await u.db("o_storyboard")
          .where("id", item.id)
          .update({
            filePath: "",
            reason: u.error(e).message,
            state: "生成失败",
          });
      }
    };

    let generateList = [];
    if (compulsory) {
      generateList = storyboardData;
    } else {
      generateList = storyboardData.filter((item) => item.shouldGenerateImage !== 0);
    }
    for (let i = 0; i < generateList.length; i += concurrentCount) {
      const batch = generateList.slice(i, i + concurrentCount);
      await Promise.all(batch.map(generateTask));
    }
  },
);

function normalizeAssetType(type: string): "role" | "scene" | "tool" | "other" {
  if (type === "role" || type === "scene" || type === "tool") return type;
  return "other";
}

function parseDataUrl(dataUrl: string) {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    throw new Error("无效的图片 base64 数据");
  }
  return {
    mimeType: match[1],
    buffer: Buffer.from(match[2], "base64"),
  };
}

function toDataUrl(buffer: Buffer, mimeType = "image/jpeg") {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

async function buildRoleMontage(images: string[]) {
  const cardWidth = 560;
  const cardHeight = 840;
  const cols = Math.min(images.length, 2);
  const rows = Math.ceil(images.length / cols);
  const gap = 28;
  const margin = 32;
  const cards = await Promise.all(
    images.map(async (image, index) => {
      const { buffer } = parseDataUrl(image);
      const card = await sharp(buffer)
        .resize(cardWidth - 48, cardHeight - 48, {
          fit: "contain",
          background: { r: 244, g: 239, b: 232, alpha: 1 },
        })
        .flatten({ background: { r: 244, g: 239, b: 232 } })
        .extend({
          top: 24,
          bottom: 24,
          left: 24,
          right: 24,
          background: { r: 255, g: 255, b: 255, alpha: 1 },
        })
        .jpeg({ quality: 90 })
        .toBuffer();
      const badgeSvg = Buffer.from(`
        <svg width="168" height="56" xmlns="http://www.w3.org/2000/svg">
          <rect x="0" y="0" rx="14" ry="14" width="168" height="56" fill="#1f2937"/>
          <text x="84" y="36" text-anchor="middle" font-size="28" font-family="sans-serif" fill="#ffffff">角色${index + 1}</text>
        </svg>
      `);
      return await sharp(card)
        .composite([{ input: badgeSvg, left: 20, top: 20 }])
        .jpeg({ quality: 90 })
        .toBuffer();
    }),
  );
  const canvas = sharp({
    create: {
      width: margin * 2 + cols * cardWidth + (cols - 1) * gap,
      height: margin * 2 + rows * cardHeight + (rows - 1) * gap,
      channels: 3,
      background: { r: 235, g: 230, b: 223 },
    },
  });
  const composite = cards.map((input, index) => ({
    input,
    left: margin + (index % cols) * (cardWidth + gap),
    top: margin + Math.floor(index / cols) * (cardHeight + gap),
  }));
  const buffer = await canvas.composite(composite).jpeg({ quality: 88 }).toBuffer();
  return await u.zipImage(toDataUrl(buffer), 2 * 1024 * 1024);
}

async function buildSceneMontage(images: string[]) {
  const tileWidth = 960;
  const tileHeight = 540;
  const gap = 16;
  const margin = 20;
  const tiles = await Promise.all(
    images.map(async (image) => {
      const { buffer } = parseDataUrl(image);
      return await sharp(buffer).resize(tileWidth, tileHeight, { fit: "cover", position: "centre" }).jpeg({ quality: 90 }).toBuffer();
    }),
  );
  const canvasWidth = margin * 2 + tiles.length * tileWidth + (tiles.length - 1) * gap;
  const canvasHeight = margin * 2 + tileHeight;
  const merged = await sharp({
    create: {
      width: canvasWidth,
      height: canvasHeight,
      channels: 3,
      background: { r: 18, g: 18, b: 18 },
    },
  })
    .composite(
      tiles.map((input, index) => ({
        input,
        left: margin + index * (tileWidth + gap),
        top: margin,
      })),
    )
    .resize({ width: 1600, withoutEnlargement: true })
    .jpeg({ quality: 88 })
    .toBuffer();
  return await u.zipImage(toDataUrl(merged), 2 * 1024 * 1024);
}

async function buildToolMontage(images: string[]) {
  const tileSize = images.length === 1 ? 960 : 520;
  const cols = images.length === 1 ? 1 : Math.min(images.length, 2);
  const rows = Math.ceil(images.length / cols);
  const gap = 24;
  const margin = 28;
  const tiles = await Promise.all(
    images.map(async (image) => {
      const { buffer } = parseDataUrl(image);
      return await sharp(buffer)
        .resize(tileSize - 72, tileSize - 72, {
          fit: "contain",
          background: { r: 255, g: 255, b: 255, alpha: 1 },
        })
        .flatten({ background: { r: 255, g: 255, b: 255 } })
        .extend({
          top: 36,
          bottom: 36,
          left: 36,
          right: 36,
          background: { r: 255, g: 255, b: 255, alpha: 1 },
        })
        .jpeg({ quality: 92 })
        .toBuffer();
    }),
  );
  const canvas = sharp({
    create: {
      width: margin * 2 + cols * tileSize + (cols - 1) * gap,
      height: margin * 2 + rows * tileSize + (rows - 1) * gap,
      channels: 3,
      background: { r: 248, g: 248, b: 248 },
    },
  });
  const composite = tiles.map((input, index) => ({
    input,
    left: margin + (index % cols) * (tileSize + gap),
    top: margin + Math.floor(index / cols) * (tileSize + gap),
  }));
  const buffer = await canvas.composite(composite).jpeg({ quality: 90 }).toBuffer();
  return await u.zipImage(toDataUrl(buffer), 2 * 1024 * 1024);
}

async function buildReferenceMontageByType(images: string[], type: "role" | "scene" | "tool" | "other") {
  if (images.length === 1) {
    if (type === "role") return await buildRoleMontage(images);
    if (type === "scene") return await buildSceneMontage(images);
    if (type === "tool") return await buildToolMontage(images);
    return images[0];
  }
  if (type === "role") return await buildRoleMontage(images);
  if (type === "scene") return await buildSceneMontage(images);
  if (type === "tool") return await buildToolMontage(images);
  return await u.mergeImages(images, "2mb");
}

async function getStoryboardReferenceList(refs: ResolvedStoryboardAssetRef[]) {
  if (!refs.length) return [];

  const withImage = refs.filter((ref) => ref.imageId);
  if (!withImage.length) return [];

  const imageIds = withImage.map((ref) => ref.imageId as number);
  const imagePaths = await u.db("o_image").whereIn("o_image.id", imageIds).select("o_image.id", "o_image.filePath");
  const id2Path = new Map<number, string>();
  for (const row of imagePaths) {
    id2Path.set(row.id, row.filePath);
  }

  const grouped: Record<string, { order: number; base64: string }[]> = { role: [], scene: [], tool: [], other: [] };
  for (const ref of withImage) {
    const filePath = id2Path.get(ref.imageId as number);
    if (!filePath) continue;
    try {
      const base64 = await u.oss.getImageBase64(filePath);
      grouped[ref.normalizedType].push({
        order: ref.labelOrder,
        base64,
      });
    } catch {
      continue;
    }
  }

  const output: { type: "image"; base64: string }[] = [];
  for (const key of ["role", "scene", "tool", "other"] as const) {
    const images = grouped[key].sort((a, b) => a.order - b.order).map((item) => item.base64);
    if (!images.length) continue;
    const compressed = await Promise.all(images.map((url) => u.zipImage(url, 700 * 1024)));
    const referenceImage = await buildReferenceMontageByType(compressed, key);
    output.push({ type: "image", base64: referenceImage });
  }
  return output;
}

function stripReferenceDefinitions(prompt: string) {
  return prompt.replace(/@图(\d+)\s*为\s*([^@\n，,]+?)(角色|场景|道具)/g, "").replace(/^[，,\s]+/, "").trim();
}

function getReferenceMentions(promptBody: string, tokenIndex: number) {
  const regex = new RegExp(`@图${tokenIndex}(?!\\d)`, "g");
  let match: RegExpExecArray | null;
  let firstMention = Number.MAX_SAFE_INTEGER;
  let mentionCount = 0;
  while ((match = regex.exec(promptBody)) !== null) {
    mentionCount += 1;
    if (firstMention === Number.MAX_SAFE_INTEGER) firstMention = match.index;
  }
  return { mentionCount, firstMention };
}

function getTokenContext(promptBody: string, tokenIndex: number) {
  const token = `@图${tokenIndex}`;
  const mentionIndex = promptBody.indexOf(token);
  return mentionIndex >= 0 ? promptBody.slice(Math.max(0, mentionIndex - 20), Math.min(promptBody.length, mentionIndex + 40)) : "";
}

function getRolePriorityScore(promptBody: string, tokenIndex: number, mentionCount: number, firstMention: number) {
  if (!mentionCount) return Number.MAX_SAFE_INTEGER;
  const context = getTokenContext(promptBody, tokenIndex);
  const mainHints = ["中央", "主位", "主体", "前景", "特写", "近景", "中景", "仰头", "盯住", "跪地", "扑到", "抱着", "画面下方中央"];
  const opponentHints = ["侧前方", "对峙", "压在", "俯视", "发问", "逼近", "威压", "高处", "面朝下方"];
  const supportHints = ["尸身", "怀里", "臂弯", "后方", "众神", "静坐", "不言", "阶边"];
  let score = firstMention;
  if (mainHints.some((hint) => context.includes(hint))) score -= 20000;
  if (opponentHints.some((hint) => context.includes(hint))) score -= 10000;
  if (supportHints.some((hint) => context.includes(hint))) score += 10000;
  score -= mentionCount * 1000;
  return score;
}

function getScenePriorityScore(promptBody: string, tokenIndex: number, mentionCount: number, firstMention: number) {
  if (!mentionCount) return Number.MAX_SAFE_INTEGER;
  const context = getTokenContext(promptBody, tokenIndex);
  const mainHints = ["内", "同框", "主场景", "画面", "殿内", "场景", "中央"];
  let score = firstMention;
  if (mainHints.some((hint) => context.includes(hint))) score -= 10000;
  score -= mentionCount * 800;
  return score;
}

function getToolPriorityScore(promptBody: string, tokenIndex: number, mentionCount: number, firstMention: number) {
  if (!mentionCount) return Number.MAX_SAFE_INTEGER;
  const context = getTokenContext(promptBody, tokenIndex);
  const keyHints = ["手中", "怀里", "近处", "阶边", "中央", "特写", "可见", "留在画面里"];
  let score = firstMention;
  if (keyHints.some((hint) => context.includes(hint))) score -= 10000;
  score -= mentionCount * 800;
  return score;
}

function resolveStoryboardRefs(prompt: string, refs: StoryboardAssetRef[]): ResolvedStoryboardAssetRef[] {
  const promptBody = stripReferenceDefinitions(prompt);
  const baseRefs: ResolvedStoryboardAssetRef[] = refs.map((ref, idx) => {
    const normalizedType = normalizeAssetType(ref.type);
    const tokenIndex = idx + 1;
    const { mentionCount, firstMention } = getReferenceMentions(promptBody, tokenIndex);
    const priorityScore =
      normalizedType === "role"
        ? getRolePriorityScore(promptBody, tokenIndex, mentionCount, firstMention)
        : normalizedType === "scene"
          ? getScenePriorityScore(promptBody, tokenIndex, mentionCount, firstMention)
          : normalizedType === "tool"
            ? getToolPriorityScore(promptBody, tokenIndex, mentionCount, firstMention)
            : tokenIndex;
    return {
      ...ref,
      tokenIndex,
      normalizedType,
      mentionCount,
      firstMention,
      priorityScore,
      label: "",
      labelOrder: 0,
    };
  });

  const labelPrefixes: Record<string, string> = {
    role: "角色参考",
    scene: "场景参考",
    tool: "道具参考",
    other: "其他参考",
  };

  for (const type of ["role", "scene", "tool", "other"] as const) {
    const group = baseRefs
      .filter((ref) => ref.normalizedType === type)
      .sort((a, b) => {
        if (type === "role" || type === "scene" || type === "tool") {
          const aMentioned = a.mentionCount > 0;
          const bMentioned = b.mentionCount > 0;
          if (aMentioned !== bMentioned) return aMentioned ? -1 : 1;
          if (a.priorityScore !== b.priorityScore) return a.priorityScore - b.priorityScore;
        }
        return a.tokenIndex - b.tokenIndex;
      });
    group.forEach((ref, idx) => {
      if (type === "scene") {
        ref.label = idx === 0 ? "主场景参考" : `次场景参考${idx}`;
      } else if (type === "tool") {
        ref.label = idx === 0 ? "关键道具参考" : `次道具参考${idx}`;
      } else {
        ref.label = `${labelPrefixes[type]}${idx + 1}`;
      }
      ref.labelOrder = idx + 1;
    });
  }

  return baseRefs.sort((a, b) => a.tokenIndex - b.tokenIndex);
}

function buildStoryboardReferencePrompt(prompt: string, refs: ResolvedStoryboardAssetRef[]) {
  const cleanedBasePrompt = stripReferenceDefinitions(prompt);
  const tokenMap = new Map<number, { label: string; name: string; type: string; labelOrder: number }>();
  refs.forEach((ref) => {
    tokenMap.set(ref.tokenIndex, {
      label: ref.label,
      name: ref.name,
      type: ref.normalizedType,
      labelOrder: ref.labelOrder,
    });
  });

  const cleanedPrompt = cleanedBasePrompt.replace(/@图(\d+)/g, (_, num) => {
    const mapped = tokenMap.get(Number(num));
    return mapped ? `【${mapped.label}:${mapped.name}】` : `【参考图${num}】`;
  });

  const groupedSummary = (["role", "scene", "tool", "other"] as const)
    .map((type) => {
      const items = Array.from(tokenMap.values())
        .filter((item) => item.type === type)
        .sort((a, b) => a.labelOrder - b.labelOrder);
      if (!items.length) return "";
      const title = type === "role" ? "角色优先顺序" : type === "scene" ? "场景参考" : type === "tool" ? "道具参考" : "其他参考";
      return `${title}：${items.map((item) => `${item.label}=${item.name}`).join("；")}`;
    })
    .filter(Boolean)
    .join("\n");

  return [
    "【参考摘要】",
    groupedSummary,
    "【约束】角色/场景/道具必须严格对应参考图；多参考必须同时成立；角色优先顺序按摘要从前到后执行。",
    cleanedPrompt,
  ].join("\n\n");
}
