"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, ClipboardPaste, Link2, Upload } from "lucide-react";
import { BottomSheet } from "@/components/ui/modal";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import {
  CONTENT_IMPORT_CHARACTER_READY_EVENT,
  CONTENT_IMPORT_OPEN_EVENT,
  bindWorldBookToCharacter,
  consumeImportLink,
  detectJsonImportKind,
  fetchImportSource,
  persistImportedCharacter,
  persistImportedWorldBook,
  pngBufferToAvatarDataUrl,
  readCharacterFromJson,
  readCharacterFromPng,
  readWorldBookFromJson,
  type ContentImportOpenDetail,
  type PreparedCharacterImport,
} from "@/lib/content-import";
import type { WorldBookConfig } from "@/lib/settings-types";

type Session = {
  mode: "menu" | "url" | "paste";
  url: string;
  offerFile: boolean;
  placeCharacter: boolean;
  onPickFile?: () => void;
  confirmFirst: boolean;
};

type Phase = "form" | "pick" | "bind" | "done";

const EMPTY_SESSION: Session = {
  mode: "menu",
  url: "",
  offerFile: false,
  placeCharacter: false,
  confirmFirst: false,
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function ContentImportHost() {
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState<Session>(EMPTY_SESSION);
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<Phase>("form");
  const [pendingText, setPendingText] = useState("");
  const [importedBook, setImportedBook] = useState<WorldBookConfig | null>(null);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [bindNote, setBindNote] = useState("");
  const [doneName, setDoneName] = useState("");
  const requestRef = useRef(0);

  function resetForm(next: Session) {
    requestRef.current += 1;
    setSession(next);
    setUrl(next.url);
    setText("");
    setError("");
    setBusy(false);
    setPhase("form");
    setPendingText("");
    setImportedBook(null);
    setCharacters([]);
    setBindNote("");
    setDoneName("");
  }

  function close() {
    requestRef.current += 1;
    setOpen(false);
    setBusy(false);
  }

  useEffect(() => {
    const linked = consumeImportLink();
    if (linked) {
      resetForm({
        mode: "url",
        url: linked,
        offerFile: false,
        placeCharacter: false,
        confirmFirst: true,
      });
      setOpen(true);
    }

    const onOpen = (event: Event) => {
      const detail = ((event as CustomEvent<ContentImportOpenDetail>).detail) ?? {};
      resetForm({
        mode: detail.mode ?? "menu",
        url: detail.url ?? "",
        offerFile: Boolean(detail.offerFile),
        placeCharacter: Boolean(detail.placeCharacter),
        onPickFile: detail.onPickFile,
        confirmFirst: Boolean(detail.confirmFirst),
      });
      setOpen(true);
    };
    window.addEventListener(CONTENT_IMPORT_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(CONTENT_IMPORT_OPEN_EVENT, onOpen);
    // Mount-only: deep link is consumed once per page load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function deliverCharacter(prepared: PreparedCharacterImport, requestId: number) {
    if (session.placeCharacter) {
      const placed = new CustomEvent(CONTENT_IMPORT_CHARACTER_READY_EVENT, {
        cancelable: true,
        detail: { ...prepared, placeOnCanvas: true },
      });
      const handedOff = !window.dispatchEvent(placed);
      if (handedOff) {
        if (requestId === requestRef.current) close();
        return;
      }
    }
    const character = await persistImportedCharacter(prepared);
    if (requestId !== requestRef.current) return;
    setDoneName(character.name.trim() || "未命名角色");
    setPhase("done");
  }

  async function deliverWorldBook(sourceText: string, requestId: number) {
    const book = readWorldBookFromJson(sourceText);
    const saved = await persistImportedWorldBook(book);
    if (requestId !== requestRef.current) return;
    setImportedBook(saved);
    setCharacters(loadCharacters());
    setBindNote("");
    setPhase("bind");
  }

  async function importJson(sourceText: string, kind: "auto" | "character" | "worldbook") {
    const requestId = requestRef.current;
    const detected = kind === "auto" ? detectJsonImportKind(sourceText) : kind;
    if (detected === "invalid-json") throw new Error("内容不是有效的 JSON");
    if (detected === "ambiguous") {
      setPendingText(sourceText);
      setPhase("pick");
      return;
    }
    if (detected === "character") {
      const data = readCharacterFromJson(sourceText);
      await deliverCharacter({ data }, requestId);
      return;
    }
    await deliverWorldBook(sourceText, requestId);
  }

  async function confirmUrl() {
    const requestId = ++requestRef.current;
    setBusy(true);
    setError("");
    try {
      const source = await fetchImportSource(url);
      if (requestId !== requestRef.current) return;
      if (source.format === "png") {
        const data = readCharacterFromPng(source.buffer);
        const avatarOverride = await pngBufferToAvatarDataUrl(source.buffer);
        if (requestId !== requestRef.current) return;
        await deliverCharacter({ data, avatarOverride }, requestId);
        return;
      }
      await importJson(source.text, "auto");
    } catch (error) {
      if (requestId !== requestRef.current) return;
      setError(errorMessage(error, "导入失败"));
    } finally {
      if (requestId === requestRef.current) setBusy(false);
    }
  }

  async function confirmPaste() {
    const requestId = ++requestRef.current;
    setBusy(true);
    setError("");
    try {
      const sourceText = text.trim();
      if (!sourceText) throw new Error("请先粘贴 JSON");
      await importJson(sourceText, "auto");
    } catch (error) {
      if (requestId !== requestRef.current) return;
      setError(errorMessage(error, "导入失败"));
    } finally {
      if (requestId === requestRef.current) setBusy(false);
    }
  }

  async function chooseKind(kind: "character" | "worldbook") {
    const requestId = ++requestRef.current;
    setBusy(true);
    setError("");
    try {
      await importJson(pendingText, kind);
    } catch (error) {
      if (requestId !== requestRef.current) return;
      setError(errorMessage(error, "导入失败"));
      setPhase("pick");
    } finally {
      if (requestId === requestRef.current) setBusy(false);
    }
  }

  async function bindTo(character: Character) {
    if (!importedBook || busy) return;
    setBusy(true);
    setError("");
    try {
      const added = await bindWorldBookToCharacter(character.id, importedBook.id);
      const name = character.name.trim() || "未命名角色";
      setBindNote(added ? `已绑定到「${name}」的默认世界书` : `「${name}」已经绑定过这本世界书`);
    } catch (error) {
      setError(errorMessage(error, "绑定失败"));
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  const title = phase === "bind"
    ? "导入世界书"
    : phase === "done"
      ? "导入完成"
      : phase === "pick"
        ? "选择类型"
        : "导入";

  return (
    <BottomSheet title={title} onClose={close}>
      <div className="flex flex-col gap-3">
        {error && (
          <div
            className="flex items-start gap-2 rounded-lg p-2.5"
            style={{ background: "color-mix(in srgb, var(--c-danger) 12%, transparent)", border: "1px solid var(--c-danger)" }}
            role="alert"
          >
            <AlertCircle size={16} className="mt-0.5 shrink-0" style={{ color: "var(--c-danger)" }} />
            <span className="ts-12" style={{ color: "var(--c-danger)" }}>{error}</span>
          </div>
        )}

        {phase === "form" && session.mode === "menu" && (
          <>
            <p className="menu-desc !mt-0">
              支持本应用导出的角色卡（JSON 或带角色数据的 PNG）和世界书 JSON。链接和粘贴会自动识别类型。
            </p>
            {session.offerFile && (
              <button
                type="button"
                className="ui-btn ui-btn-outline w-full"
                onClick={() => {
                  session.onPickFile?.();
                  close();
                }}
              >
                <Upload size={16} /> 本地文件
              </button>
            )}
            <button type="button" className="ui-btn ui-btn-outline w-full" onClick={() => { setSession((current) => ({ ...current, mode: "url" })); setError(""); }}>
              <Link2 size={16} /> 从链接导入
            </button>
            <button type="button" className="ui-btn ui-btn-outline w-full" onClick={() => { setSession((current) => ({ ...current, mode: "paste" })); setError(""); }}>
              <ClipboardPaste size={16} /> 粘贴 JSON
            </button>
          </>
        )}

        {phase === "form" && session.mode === "url" && (
          <>
            <p className="menu-desc !mt-0">
              {session.confirmFirst
                ? "这是通过链接打开的导入。地址已填好，确认后才会获取，不会自动导入。"
                : "粘贴 https 链接。确认后才会获取 JSON 或 PNG，不会自动导入。"}
            </p>
            <input
              className="ui-input"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="https://example.com/card.json"
              aria-label="导入链接"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
            <button type="button" className="ui-btn ui-btn-primary w-full" disabled={busy} onClick={() => { void confirmUrl(); }}>
              {busy ? "正在获取…" : "确认导入"}
            </button>
            <button
              type="button"
              className="ui-btn ui-btn-ghost w-full"
              disabled={busy}
              onClick={() => { setSession((current) => ({ ...current, mode: "paste", confirmFirst: false })); setError(""); }}
            >
              改为粘贴 JSON
            </button>
          </>
        )}

        {phase === "form" && session.mode === "paste" && (
          <>
            <p className="menu-desc !mt-0">
              粘贴角色卡或世界书的 JSON。确认后才会导入，并自动识别类型。
            </p>
            <textarea
              className="ui-textarea"
              style={{ minHeight: 180 }}
              placeholder="在此粘贴 JSON"
              aria-label="粘贴 JSON"
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
            <button type="button" className="ui-btn ui-btn-primary w-full" disabled={busy} onClick={() => { void confirmPaste(); }}>
              {busy ? "正在导入…" : "确认导入"}
            </button>
            <button
              type="button"
              className="ui-btn ui-btn-ghost w-full"
              disabled={busy}
              onClick={() => { setSession((current) => ({ ...current, mode: "url" })); setError(""); }}
            >
              改为从链接导入
            </button>
          </>
        )}

        {phase === "pick" && (
          <>
            <p className="menu-desc !mt-0">无法确定这是角色卡还是世界书，请选择导入类型。</p>
            <button type="button" className="ui-btn ui-btn-primary w-full" disabled={busy} onClick={() => { void chooseKind("character"); }}>
              导入为角色卡
            </button>
            <button type="button" className="ui-btn ui-btn-outline w-full" disabled={busy} onClick={() => { void chooseKind("worldbook"); }}>
              导入为世界书
            </button>
          </>
        )}

        {phase === "bind" && importedBook && (
          <>
            <p className="menu-desc !mt-0">
              已导入世界书「{importedBook.name || "导入的世界书"}」（{importedBook.entries?.length || 0} 条）。可以绑定到角色的默认世界书，也可以稍后在设置的绑定页里再选。
            </p>
            {bindNote && <p className="menu-desc !mt-0">{bindNote}</p>}
            {characters.length === 0 ? (
              <p className="menu-desc !mt-0">当前还没有角色。先在角色页导入或创建一个，再到绑定页关联这本世界书。</p>
            ) : (
              <div className="flex max-h-[40vh] flex-col gap-2 overflow-y-auto">
                {characters.map((character) => (
                  <button
                    key={character.id}
                    type="button"
                    className="ui-btn ui-btn-outline w-full"
                    disabled={busy}
                    onClick={() => { void bindTo(character); }}
                  >
                    绑定到 {character.name.trim() || "未命名角色"}
                  </button>
                ))}
              </div>
            )}
            <button type="button" className="ui-btn ui-btn-primary w-full" onClick={close}>
              完成
            </button>
          </>
        )}

        {phase === "done" && (
          <>
            <p className="menu-desc !mt-0">已导入角色「{doneName}」。打开角色页就能看到。</p>
            <button type="button" className="ui-btn ui-btn-primary w-full" onClick={close}>
              完成
            </button>
          </>
        )}
      </div>
    </BottomSheet>
  );
}
