/**
 * URL / pasted-JSON import for character cards and world books.
 *
 * Detection only chooses which existing parser to call. Validation, accepted
 * fields, and the stored shape stay in parseCharacterFromJson / parseCharacterFromPng
 * and parseWorldBookFromJson.
 */
import {
  CHAR_BLOCKED_FIELDS,
  createCharacter,
  loadCharacters,
  parseCharacterFromJson,
  parseCharacterFromPng,
  saveCharacters,
  type CharacterImportData,
} from "./character-storage";
import type { Character } from "./character-types";
import { hydrateKvDb } from "./kv-db";
import {
  UNSUPPORTED_IMPORT_FORMAT,
  ensureSettingsStorageHydrated,
  getCharacterBinding,
  loadBindingConfig,
  loadWorldBooks,
  parseWorldBookFromJson,
  saveBindingConfig,
  saveWorldBooks,
  setCharacterBinding,
} from "./settings-storage";
import type { WorldBookConfig } from "./settings-types";

export const CONTENT_IMPORT_OPEN_EVENT = "content-import-open";
export const CONTENT_IMPORT_CHARACTER_READY_EVENT = "content-import-character-ready";
export const CHARACTERS_UPDATED_EVENT = "ai-phone-characters-updated";
export const WORLDBOOKS_UPDATED_EVENT = "settings-worldbooks-updated";

export type ContentImportOpenMode = "menu" | "url" | "paste";

export type ContentImportOpenDetail = {
  mode?: ContentImportOpenMode;
  url?: string;
  /** Character-app menu: offer the existing local-file picker. */
  offerFile?: boolean;
  /** When the character canvas is open, hand the card back for polaroid placement. */
  placeCharacter?: boolean;
  onPickFile?: () => void;
  /** Deep link: the URL is prefilled and nothing is fetched until the user confirms. */
  confirmFirst?: boolean;
};

export type PreparedCharacterImport = {
  data: CharacterImportData;
  /** PNG bytes used as the portrait. Empty means keep data.avatar. */
  avatarOverride?: string | null;
  placeOnCanvas?: boolean;
};

export type JsonImportKind = "character" | "worldbook" | "ambiguous" | "invalid-json";

export type ImportSource =
  | { format: "json"; text: string }
  | { format: "png"; buffer: ArrayBuffer };

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export function openContentImport(detail: ContentImportOpenDetail = {}): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(CONTENT_IMPORT_OPEN_EVENT, { detail }));
}

/** Read `?import=` or `#import=` once and remove it so a refresh does not import again. */
export function consumeImportLink(): string | null {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  const queryValue = url.searchParams.get("import");
  const rawHash = url.hash.startsWith("#") ? url.hash.slice(1) : "";
  let hashValue: string | null = null;
  if (rawHash) {
    const hashParams = new URLSearchParams(rawHash);
    hashValue = hashParams.get("import");
  }
  const value = (queryValue || hashValue || "").trim();
  if (!value) return null;

  if (queryValue !== null) url.searchParams.delete("import");
  if (hashValue !== null && rawHash) {
    const hashParams = new URLSearchParams(rawHash);
    hashParams.delete("import");
    const nextHash = hashParams.toString();
    url.hash = nextHash ? `#${nextHash}` : "";
  }
  const next = `${url.pathname}${url.search}${url.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next !== current) window.history.replaceState(null, "", next);
  return value;
}

export function detectJsonImportKind(text: string): JsonImportKind {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "invalid-json";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "ambiguous";

  const obj = parsed as Record<string, unknown>;
  const nested = obj.schema === "ai_phone_character" && obj.data && typeof obj.data === "object" && !Array.isArray(obj.data)
    ? obj.data as Record<string, unknown>
    : null;
  const isCharacterSchema = obj.schema === "ai_phone_character" || nested?.schema === "ai_phone_character";
  const hasEntries = Object.prototype.hasOwnProperty.call(obj, "entries")
    || (nested ? Object.prototype.hasOwnProperty.call(nested, "entries") : false);

  if (isCharacterSchema && hasEntries) return "ambiguous";
  if (isCharacterSchema) return "character";
  if (hasEntries) return "worldbook";
  return "ambiguous";
}

function isPng(buffer: ArrayBuffer): boolean {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < PNG_SIGNATURE.length) return false;
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

function isLocalDevHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1";
}

export async function fetchImportSource(rawUrl: string): Promise<ImportSource> {
  const trimmed = rawUrl.trim();
  if (!trimmed) throw new Error("请粘贴链接");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("链接格式不正确");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("只支持 https 链接");
  }
  if (url.protocol === "http:" && !isLocalDevHost(url.hostname)) {
    throw new Error("请使用 https 链接");
  }

  let response: Response;
  try {
    response = await fetch(url.toString(), { mode: "cors", cache: "no-store" });
  } catch {
    throw new Error("无法获取该链接（请求失败）。常见原因是跨域限制，或地址无法访问。请确认该链接允许当前网页读取。");
  }
  if (!response.ok) {
    throw new Error(`获取失败：服务器返回 HTTP ${response.status}`);
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength === 0) throw new Error("链接内容为空");

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  const path = url.pathname.toLowerCase();
  const looksLikePng = isPng(buffer) || contentType.includes("image/png") || path.endsWith(".png");
  if (looksLikePng) {
    if (!isPng(buffer)) throw new Error("链接看起来是 PNG，但内容不是有效的 PNG 文件");
    return { format: "png", buffer };
  }

  const text = new TextDecoder("utf-8").decode(buffer).replace(/^\uFEFF/, "").trim();
  if (!text) throw new Error("链接内容为空");
  return { format: "json", text };
}

export function readCharacterFromJson(text: string): CharacterImportData {
  try {
    const data = parseCharacterFromJson(text);
    if (!data) throw new Error("解析失败，请检查文件格式");
    return data;
  } catch (error) {
    if (error instanceof Error && error.message === CHAR_BLOCKED_FIELDS) {
      throw new Error("不支持包含开场白、场景或示例对话的角色卡");
    }
    if (error instanceof Error && error.message === "解析失败，请检查文件格式") throw error;
    throw new Error("解析失败，请检查文件格式");
  }
}

export function readCharacterFromPng(buffer: ArrayBuffer): CharacterImportData {
  try {
    const data = parseCharacterFromPng(buffer);
    if (!data) throw new Error("未在 PNG 中找到角色数据");
    return data;
  } catch (error) {
    if (error instanceof Error && error.message === CHAR_BLOCKED_FIELDS) {
      throw new Error("不支持包含开场白、场景或示例对话的角色卡");
    }
    if (error instanceof Error && error.message === "未在 PNG 中找到角色数据") throw error;
    throw new Error("未在 PNG 中找到角色数据");
  }
}

export function readWorldBookFromJson(text: string): WorldBookConfig {
  try {
    const book = parseWorldBookFromJson(text);
    if (!book) throw new Error("无法解析世界书文件，格式不正确。");
    return book;
  } catch (error) {
    if (error instanceof Error && error.message === UNSUPPORTED_IMPORT_FORMAT) {
      throw new Error("不支持该世界书格式");
    }
    if (error instanceof Error && error.message === "无法解析世界书文件，格式不正确。") throw error;
    throw new Error("无法解析世界书文件，格式不正确。");
  }
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("读取图片失败"));
    reader.readAsDataURL(blob);
  });
}

/** Match the file-import portrait path closely enough to keep PNG cards usable. */
export async function pngBufferToAvatarDataUrl(buffer: ArrayBuffer): Promise<string> {
  const rawBlob = new Blob([buffer], { type: "image/png" });
  const raw = await blobToDataUrl(rawBlob);
  if (typeof document === "undefined") return raw;

  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("图片无法显示"));
      element.src = raw;
    });
    const attempts = [
      { maxSize: 1280, quality: 0.8 },
      { maxSize: 1024, quality: 0.72 },
      { maxSize: 768, quality: 0.68 },
      { maxSize: 512, quality: 0.6 },
    ];
    const canvas = document.createElement("canvas");
    for (const attempt of attempts) {
      const scale = Math.min(1, attempt.maxSize / Math.max(image.width, image.height));
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) return raw;
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      const compressed = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob((blob) => resolve(blob), "image/webp", attempt.quality);
      });
      if (compressed && compressed.size <= 600 * 1024) return await blobToDataUrl(compressed);
    }
  } catch {
    return raw;
  }
  return raw;
}

export async function persistImportedCharacter(prepared: PreparedCharacterImport): Promise<Character> {
  await hydrateKvDb();
  const existing = loadCharacters();
  const avatar = prepared.avatarOverride && prepared.avatarOverride.trim()
    ? prepared.avatarOverride
    : (prepared.data.avatar ?? null);
  const character = createCharacter({ ...prepared.data, avatar });
  character.canvasX = 96 + (existing.length % 4) * 48;
  character.canvasY = 120 + (existing.length % 3) * 36;
  character.canvasRot = ((existing.length * 11) % 18) - 9;
  character.canvasZIndex = 100 + existing.length;
  saveCharacters([...existing, character]);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(CHARACTERS_UPDATED_EVENT));
  }
  return character;
}

export async function persistImportedWorldBook(book: WorldBookConfig): Promise<WorldBookConfig> {
  await Promise.all([hydrateKvDb(), ensureSettingsStorageHydrated()]);
  saveWorldBooks([book, ...loadWorldBooks()]);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(WORLDBOOKS_UPDATED_EVENT, { detail: { id: book.id } }));
  }
  return book;
}

export async function bindWorldBookToCharacter(characterId: string, worldBookId: string): Promise<boolean> {
  await Promise.all([hydrateKvDb(), ensureSettingsStorageHydrated()]);
  const config = loadBindingConfig();
  const binding = getCharacterBinding(config, characterId);
  const current = binding.defaults.worldBookIds ?? [];
  if (current.includes(worldBookId)) return false;
  const next = setCharacterBinding(config, {
    ...binding,
    defaults: { ...binding.defaults, worldBookIds: [...current, worldBookId] },
  });
  saveBindingConfig(next);
  return true;
}
