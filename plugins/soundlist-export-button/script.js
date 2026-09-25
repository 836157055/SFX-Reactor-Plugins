const manifest = {
  id: "soundlist-export-button",
  name: "一键导出素材列表",
  version: "1.5.1",
  author: "SFX Reactor AI",
  description:
    "在播放控制栏增加纯图标的「导出数据」按钮（悬停显示作用提示），并在素材列表右键菜单提供「导出素材列表数据（CSV）」：确认后导出为 CSV 表格并显示导出进度条。",
  entryPoint: "script.js",
  permissions: ["read_library", "file_system"],
  tags: ["export", "csv", "transport", "context-menu"],
};

const STYLE_ID = "sfx-est-styles";
const OVERLAY_ID = "sfx-est-overlay";
const TOOL_NAME = "plugin.soundlist-export-button.export_current_view";
const PAGE_SIZE = 500;
const MAX_PAGES = 80;

// 播放控制栏按钮的文字标签：走带栏不渲染文本，宿主仅用它作悬停 title / aria-label
const TRANSPORT_BUTTON_LABEL = "导出素材列表数据（CSV）";

// 插件上下文由 init(pluginCtx) 注入，运行环境不提供全局 plugin 对象，这里自行保存引用
let ctx = null;
let busy = false;

const CSS = `
#${OVERLAY_ID}{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);font-family:inherit}
#${OVERLAY_ID} .sfx-est-card{width:480px;max-width:calc(100vw - 48px);background:#20222a;color:#e8e8ea;border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:20px 22px;box-shadow:0 20px 60px rgba(0,0,0,.55)}
#${OVERLAY_ID} .sfx-est-title{font-size:16px;font-weight:600;margin-bottom:8px}
#${OVERLAY_ID} .sfx-est-desc{font-size:13px;line-height:1.6;color:#a9adb8}
#${OVERLAY_ID} .sfx-est-scope{margin-top:14px;display:flex;flex-direction:column;gap:8px}
#${OVERLAY_ID} .sfx-est-radio{display:flex;align-items:flex-start;gap:8px;padding:9px 11px;border:1px solid rgba(255,255,255,.14);border-radius:9px;cursor:pointer;font-size:13px}
#${OVERLAY_ID} .sfx-est-radio:hover{background:rgba(255,255,255,.05)}
#${OVERLAY_ID} .sfx-est-radio input{margin-top:2px}
#${OVERLAY_ID} .sfx-est-radio small{display:block;color:#8e94a1;font-size:11.5px;margin-top:2px}
#${OVERLAY_ID} .sfx-est-progress{margin-top:16px}
#${OVERLAY_ID} .sfx-est-progress-info{display:flex;justify-content:space-between;gap:10px;font-size:12px;color:#9aa0ad;margin-bottom:6px}
#${OVERLAY_ID} .sfx-est-progress-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#${OVERLAY_ID} .sfx-est-track{height:8px;border-radius:999px;background:rgba(255,255,255,.12);overflow:hidden}
#${OVERLAY_ID} .sfx-est-bar{height:100%;width:0;border-radius:999px;background:linear-gradient(90deg,#4f8cff,#59d6a5);transition:width .18s ease}
#${OVERLAY_ID} .sfx-est-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:20px}
#${OVERLAY_ID} .sfx-est-btn{cursor:pointer;border-radius:8px;border:1px solid rgba(255,255,255,.16);background:transparent;color:#e8e8ea;font-size:13px;padding:7px 16px}
#${OVERLAY_ID} .sfx-est-btn:hover{background:rgba(255,255,255,.08)}
#${OVERLAY_ID} .sfx-est-primary{background:#4f8cff;border-color:#4f8cff;color:#fff}
#${OVERLAY_ID} .sfx-est-primary:hover{background:#3d7bf0}
#${OVERLAY_ID} .sfx-est-btn:disabled{opacity:.5;cursor:default}
`;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

/* ---------- 通用工具 ---------- */

function pick(obj, keys) {
  if (!obj) return "";
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return "";
}

// 只覆盖非空值，避免高优先级来源里的 null/空串把已有值抹掉
function mergeNonEmpty() {
  const out = {};
  for (let i = 0; i < arguments.length; i++) {
    const o = arguments[i];
    if (!o) continue;
    for (const k in o) {
      const v = o[k];
      if (v === undefined || v === null || v === "") continue;
      out[k] = v;
    }
  }
  return out;
}

function csvCell(v) {
  const s = v === undefined || v === null ? "" : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function msToText(ms) {
  const secs = ms / 1000;
  if (!isFinite(secs) || secs <= 0) return "";
  if (secs >= 60) {
    const m = Math.floor(secs / 60);
    return m + ":" + String(Math.floor(secs % 60)).padStart(2, "0");
  }
  return secs.toFixed(2) + "s";
}

function formatDuration(rec) {
  const ms = Number(pick(rec, ["durationMs"]));
  if (isFinite(ms) && ms > 0) return msToText(ms);
  const d = pick(rec, ["duration", "length"]);
  if (d !== "" && !isFinite(Number(d))) return String(d); // 形如 "00:47"
  const secs = Number(pick(rec, ["durationSecs", "durationSeconds"]));
  if (isFinite(secs) && secs > 0) return msToText(secs * 1000);
  return "";
}

function formatSize(bytes) {
  const n = Number(bytes);
  if (!isFinite(n) || n <= 0) return "";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1048576).toFixed(2) + " MB";
}

function formatTags(v) {
  if (Array.isArray(v)) return v.filter(Boolean).join("; ");
  return v ? String(v) : "";
}

function fileExt(rec) {
  const name = String(pick(rec, ["fileName", "filename", "name", "path", "absolutePath"]) || "");
  const m = /\.([a-z0-9]{1,5})$/i.exec(name);
  return m ? m[1].toUpperCase() : "";
}

function sourceLabel(rec, libNames) {
  const libId = Number(pick(rec, ["libraryId"]));
  if (isFinite(libId) && libNames[libId]) return libNames[libId];
  const src = String(pick(rec, ["source", "origin"]) || "");
  if (src === "local") return "本地素材库";
  if (src === "browser") return "AI 生成收件箱";
  if (src === "freesound") return "Freesound 在线";
  return src;
}

const COLUMNS = [
  "序号",
  "文件名",
  "时长",
  "格式",
  "采样率",
  "声道",
  "位深",
  "文件大小",
  "标签",
  "UCS 分类",
  "UCS 子类",
  "专辑",
  "艺术家",
  "风格",
  "日期",
  "BPM",
  "调性",
  "收藏",
  "描述",
  "备注",
  "来源库",
  "路径",
];

function buildRow(index, rec, libNames) {
  return [
    index,
    pick(rec, ["fileName", "filename", "name", "title"]),
    formatDuration(rec),
    pick(rec, ["format", "fileType"]) || fileExt(rec),
    pick(rec, ["sampleRate", "samplerate"]),
    pick(rec, ["channels", "channelCount"]),
    pick(rec, ["bitDepth", "bitdepth"]),
    formatSize(pick(rec, ["fileSizeBytes", "sizeBytes", "fileSize"])),
    formatTags(pick(rec, ["tags", "tagList"])),
    pick(rec, ["ucsCategoryFull", "ucsCategory", "ucs", "category"]),
    pick(rec, ["ucsSubCategory", "ucsSub"]),
    pick(rec, ["album"]),
    pick(rec, ["artist"]),
    pick(rec, ["genre"]),
    pick(rec, ["date"]),
    pick(rec, ["bpm"]),
    pick(rec, ["key"]),
    rec && rec.favorite ? "是" : "",
    pick(rec, ["description"]),
    pick(rec, ["comment", "notes", "remark"]),
    sourceLabel(rec, libNames),
    pick(rec, ["absolutePath", "path", "filePath"]) ||
      (typeof rec.rawId === "string" ? rec.rawId : ""),
  ]
    .map(csvCell)
    .join(",");
}

function requireCtx() {
  if (!ctx || typeof ctx.callTool !== "function") {
    throw new Error("插件上下文未就绪");
  }
  return ctx;
}

function toLocalId(rawId) {
  if (typeof rawId === "number" && isFinite(rawId)) return rawId;
  if (typeof rawId === "string" && /^\d+$/.test(rawId.trim())) return Number(rawId.trim());
  return null; // AI 生成收件箱等场景给的是文件路径字符串，不是本地素材 id
}

async function fetchLibraryNames(api) {
  const names = {};
  try {
    const res = await api.callTool("list_libraries");
    const libs = res && res.ok && res.data && Array.isArray(res.data.libraries) ? res.data.libraries : [];
    for (const lib of libs) {
      if (lib && lib.id !== undefined) names[lib.id] = lib.name || "";
    }
  } catch (e) {
    /* 库名只是锦上添花，失败不阻断导出 */
  }
  return names;
}

function readView(api) {
  return api.callTool("get_current_view_sounds").then((res) => {
    const d = res && res.ok ? res.data : null;
    return {
      viewLabel: (d && d.viewLabel) || "",
      count: Number(d && d.count) || 0,
      items: d && Array.isArray(d.items) ? d.items : [],
    };
  });
}

// 探测当前页签对应的库与全量条数（页签列表只加载约百条，全量要走分页接口）
async function prepareScope() {
  const api = requireCtx();
  const view = await readView(api);
  const libIds = {};
  for (const it of view.items) {
    const id = toLocalId(it && it.id);
    if (id !== null && it.libraryId !== undefined && it.libraryId !== null) libIds[it.libraryId] = true;
  }
  const ids = Object.keys(libIds);
  let full = null;
  if (ids.length === 1 && view.items.length) {
    const libraryId = Number(ids[0]);
    const probe = await api.callTool("query_library_sounds", { libraryId, limit: 1 });
    if (probe && probe.ok && probe.data) {
      const libNames = await fetchLibraryNames(api);
      full = {
        libraryId,
        total: Number(probe.data.total) || 0,
        libraryName: libNames[libraryId] || "",
      };
    }
  }
  return { api, view, full };
}

// 分页遍历整库（返回全字段记录）
async function paginateLibrary(api, libraryId, onProgress) {
  const records = [];
  let cursor;
  let total = 0;
  let first = true;
  for (let page = 0; page < MAX_PAGES; page++) {
    const args = { libraryId, limit: PAGE_SIZE };
    if (!first && cursor) args.cursor = cursor;
    const res = await api.callTool("query_library_sounds", args);
    if (!res || !res.ok || !res.data) {
      if (first) throw new Error(res && res.error ? res.error : "读取素材库失败");
      break;
    }
    const data = res.data;
    const items = Array.isArray(data.items) ? data.items : [];
    for (const it of items) records.push(it);
    total = Number(data.total) || records.length;
    if (onProgress) onProgress(records.length, total);
    if (!data.hasMore || !items.length || !data.nextCursor) break;
    cursor = data.nextCursor;
    first = false;
    await new Promise((r) => setTimeout(r, 0));
  }
  return { records, total };
}

async function collectFull(api, full, onProgress) {
  const libNames = await fetchLibraryNames(api);
  const { records } = await paginateLibrary(api, full.libraryId, (done, total) => {
    if (onProgress) onProgress(done, total, "读取库元数据", 8, 87);
  });
  const lines = [COLUMNS.map(csvCell).join(",")];
  for (let i = 0; i < records.length; i++) {
    const rec = Object.assign({}, records[i], { rawId: records[i].id });
    lines.push(buildRow(i + 1, rec, libNames));
    if (onProgress) onProgress(i + 1, records.length, rec.fileName || "", 87, 11);
    if (i % 50 === 49) await new Promise((r) => setTimeout(r, 0));
  }
  return { lines, count: records.length, enriched: records.length, missing: 0 };
}

async function collectView(api, view, full, onProgress) {
  let items = view.items.slice();
  if (!items.length) {
    const selRes = await api.callTool("get_selected_sounds");
    const selData = selRes && selRes.ok ? selRes.data : null;
    const sel = selData && Array.isArray(selData.all) ? selData.all : [];
    if (!sel.length) throw new Error("当前素材列表没有可导出的素材");
    items = sel.slice();
  }

  const libNames = await fetchLibraryNames(api);

  let libMap = {};
  const needMap = full && items.some((it) => toLocalId(it && it.id) !== null);
  if (needMap) {
    const { records } = await paginateLibrary(api, full.libraryId, (done, total) => {
      if (onProgress) onProgress(done, total, "读取库元数据", 8, 52);
    });
    for (const r of records) if (r && r.id !== undefined) libMap[r.id] = r;
  }

  const lines = [COLUMNS.map(csvCell).join(",")];
  let missing = 0;
  let enriched = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i] || {};
    const localId = toLocalId(item.id);
    let details = null;
    if (localId !== null) {
      details = libMap[localId] || null;
      if (!details) {
        const det = await api.callTool("get_sound_details", { soundId: localId });
        if (det && det.ok && det.data) details = det.data;
      }
    }
    const rec = mergeNonEmpty(item, details);
    rec.rawId = item.id;
    if (details) enriched++;
    else missing++;
    lines.push(buildRow(i + 1, rec, libNames));
    if (onProgress) onProgress(i + 1, items.length, rec.fileName || "", 60, 39);
    if (i % 25 === 24) await new Promise((r) => setTimeout(r, 0));
  }

  return { lines, count: items.length, enriched, missing };
}

async function runExport(opts, onProgress, onPhase) {
  const api = requireCtx();
  const scope = opts && opts.scope ? opts.scope : await prepareScope();
  const mode = opts && opts.mode ? opts.mode : scope.full ? "full" : "view";

  if (onPhase) onPhase("读取素材列表…");
  const result =
    mode === "full" && scope.full
      ? await collectFull(api, scope.full, onProgress)
      : await collectView(api, scope.view, scope.full, onProgress);

  if (onPhase) onPhase("写入文件…");
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const saveRes = await api.saveTextFile({
    defaultFileName: "素材列表_" + stamp + ".csv",
    content: "\ufeff" + result.lines.join("\r\n") + "\r\n",
    filterName: "CSV 表格文件",
    extensions: ["csv"],
  });

  return Object.assign({ scopeLabel: mode === "full" ? "整个素材库" : "当前列表" }, result, {
    saveRes: saveRes || {},
  });
}

function createDialog(scope) {
  ensureStyles();
  const old = document.getElementById(OVERLAY_ID);
  if (old) old.remove();

  const viewCount = scope.view.items.length;
  const showScopeChoice = !!(scope.full && scope.full.total > viewCount);
  const viewLabel = scope.view.viewLabel ? "当前页签：" + scope.view.viewLabel + "。" : "";
  const libName = scope.full && scope.full.libraryName ? "「" + scope.full.libraryName + "」" : "";

  const scopeHtml = showScopeChoice
    ? '<div class="sfx-est-scope">' +
      '<label class="sfx-est-radio"><input type="radio" name="sfx-est-scope" value="full" checked>' +
      "<span>整个素材库" +
      libName +
      "（全部 " +
      scope.full.total +
      " 条）<small>完整导出该库所有素材，推荐</small></span></label>" +
      '<label class="sfx-est-radio"><input type="radio" name="sfx-est-scope" value="view">' +
      "<span>仅当前列表已加载的 " +
      viewCount +
      " 条<small>页签列表只加载了约百条，不含未加载部分</small></span></label>" +
      "</div>"
    : "";

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;

  const card = document.createElement("div");
  card.className = "sfx-est-card";
  card.innerHTML =
    '<div class="sfx-est-title">导出当前素材列表</div>' +
    '<div class="sfx-est-desc">' +
    viewLabel +
    "将导出素材数据为 CSV 表格文件。确认后请选择保存位置。</div>" +
    scopeHtml +
    '<div class="sfx-est-progress" hidden>' +
    '  <div class="sfx-est-progress-info"><span class="sfx-est-progress-label">准备中…</span><span class="sfx-est-progress-pct">0%</span></div>' +
    '  <div class="sfx-est-track"><div class="sfx-est-bar"></div></div>' +
    "</div>" +
    '<div class="sfx-est-actions">' +
    '  <button class="sfx-est-btn sfx-est-cancel">取消</button>' +
    '  <button class="sfx-est-btn sfx-est-primary sfx-est-confirm">确认导出</button>' +
    "</div>";
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  const progressWrap = card.querySelector(".sfx-est-progress");
  const labelEl = card.querySelector(".sfx-est-progress-label");
  const pctEl = card.querySelector(".sfx-est-progress-pct");
  const barEl = card.querySelector(".sfx-est-bar");
  const cancelBtn = card.querySelector(".sfx-est-cancel");
  const confirmBtn = card.querySelector(".sfx-est-confirm");

  function chosenMode() {
    const checked = card.querySelector('input[name="sfx-est-scope"]:checked');
    if (checked) return checked.value;
    return scope.full ? "full" : "view";
  }

  const ui = {
    mode: chosenMode,
    close() {
      const el = document.getElementById(OVERLAY_ID);
      if (el) el.remove();
    },
    showProgress() {
      progressWrap.hidden = false;
    },
    setProgress(pct, label) {
      const p = Math.max(0, Math.min(100, Math.round(pct || 0)));
      barEl.style.width = p + "%";
      pctEl.textContent = p + "%";
      if (label) labelEl.textContent = label;
    },
    lockButtons() {
      confirmBtn.disabled = true;
      cancelBtn.disabled = true;
    },
  };

  cancelBtn.addEventListener("click", () => {
    if (busy) return;
    ui.close();
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay && !busy) ui.close();
  });
  confirmBtn.addEventListener("click", () => {
    handleConfirm(ui, scope);
  });

  return ui;
}

async function openDialog() {
  let scope = null;
  try {
    scope = await prepareScope();
  } catch (e) {
    if (ctx && ctx.showToast) {
      ctx.showToast("读取素材列表失败：" + (e && e.message ? e.message : String(e)), "error");
    }
    return;
  }
  createDialog(scope);
}

async function handleConfirm(ui, scope) {
  if (busy) return;
  busy = true;
  ui.lockButtons();
  ui.showProgress();
  ui.setProgress(0, "准备中…");

  try {
    const res = await runExport(
      { scope, mode: ui.mode() },
      (done, total, name, base, span) => {
        const b = base || 0;
        const s = span || 100;
        const pct = total ? b + (done / total) * s : b;
        const label = total
          ? done +
            "/" +
            total +
            " · " +
            (name || "处理中") +
            "（" +
            (ui.mode() === "full" ? "整个素材库" : "当前列表") +
            "）"
          : "整理数据…";
        ui.setProgress(pct, label);
      },
      (phase) => ui.setProgress(2, phase)
    );

    if (res.saveRes.cancelled) {
      ui.setProgress(100, "已取消保存");
      if (ctx && ctx.showToast) ctx.showToast("已取消导出", "info");
    } else if (res.saveRes.saved) {
      ui.setProgress(100, "导出完成");
      if (ctx && ctx.showToast) {
        let msg = "已从" + res.scopeLabel + "导出 " + res.count + " 条素材 → " + res.saveRes.path;
        if (res.missing) msg += "（其中 " + res.missing + " 条无本地元数据，详情列为空）";
        ctx.showToast(msg, "info");
      }
    } else {
      ui.setProgress(100, "导出未完成");
      if (ctx && ctx.showToast) ctx.showToast("导出未完成：未取得保存路径", "error");
    }
  } catch (e) {
    ui.setProgress(100, "导出失败");
    if (ctx && ctx.showToast) {
      ctx.showToast("导出失败：" + (e && e.message ? e.message : String(e)), "error");
    }
  } finally {
    busy = false;
    setTimeout(() => ui.close(), 1200);
  }
}

function triggerExport() {
  if (busy) {
    if (ctx && ctx.showToast) ctx.showToast("导出正在进行中…", "warning");
    return;
  }
  openDialog();
}

async function init(pluginCtx) {
  ctx = pluginCtx;

  await pluginCtx.registerTool(
    {
      name: TOOL_NAME,
      description:
        "把素材列表导出为 CSV 表格文件，带确认弹窗与导出进度条。默认导出当前页签所属整个素材库（全量），页签只加载约百条时不会漏掉未加载部分；无法识别所属库时退化为当前已加载列表。用户说「导出素材列表」「把当前列表导出表格」时使用。",
      parameters: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            description: "导出范围：full=整个素材库（默认，推荐）；view=仅当前页签已加载的素材。",
            enum: ["full", "view"],
          },
        },
      },
    },
    async (args) => {
      if (busy) return { ok: false, error: "已有导出任务正在进行" };
      try {
        const scope = await prepareScope();
        const requested = args && args.scope === "view" ? "view" : "full";
        const mode = requested === "view" || !scope.full ? "view" : "full";
        const res = await runExport({ scope, mode }, null, null);
        if (res.saveRes.cancelled) {
          return { ok: true, data: { cancelled: true, count: res.count, scope: res.scopeLabel } };
        }
        if (!res.saveRes.saved) return { ok: false, error: "导出未完成：未取得保存路径" };
        return {
          ok: true,
          data: {
            count: res.count,
            scope: res.scopeLabel,
            rowsWithoutMetadata: res.missing,
            path: res.saveRes.path,
          },
        };
      } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e) };
      }
    }
  );

  // 播放控制栏按钮（location: "transport"）：lucide 线条图标，与原生走带按钮同一图标库、同一风格；
  // 文字标签仅作悬停 title / aria-label（走带栏不渲染文本），悬停提示由宿主原生提供
  pluginCtx.registerToolbarButton({
    id: "plugin.soundlist_export_button.export_transport",
    label: TRANSPORT_BUTTON_LABEL,
    icon: "lucide:file-down",
    location: "transport",
    onClick: () => triggerExport(),
  });

  // 素材列表右键菜单入口
  pluginCtx.registerContextMenu({
    id: "plugin.soundlist_export_button.export_menu",
    label: "导出素材列表数据（CSV）",
    separatorBefore: true,
    canShow: () => !busy,
    onClick: () => triggerExport(),
  });
}

function unload() {
  const overlay = document.getElementById(OVERLAY_ID);
  if (overlay) overlay.remove();
  const style = document.getElementById(STYLE_ID);
  if (style) style.remove();
  busy = false;
  ctx = null;
}

export { manifest, init, unload };
