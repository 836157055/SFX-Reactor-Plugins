// SFX Reactor 插件：发送到 REAPER 光标位置
// 在素材列表右键菜单增加「发送到reaper（快捷键）」：把当前选中素材（支持多选）
// 插入到 REAPER 当前编辑光标位置（edit cursor = reaper.GetCursorPosition()）。
//
// 落位实现（工程师实测确认，对应设计稿「分支 A」）：
//   内置 REAPER 类工具 send_to_reaper({ soundIds: number[] }) 的语义就是「在编辑光标处插入」，
//   由 reaper_control 权限桥接调用即可，无需 reaper_run_lua 兜底。
//   实测：提交 2 条素材 → REAPER 侧在光标处依次铺开（第 1 条落在光标位置，第 2 条紧随其尾部），
//   返回 { inserted, missing } 逐条结果。故本插件一次提交全部 id，不自行拼接时间轴、
//   不新开轨道对抗内置语义，只如实汇报逐条结果。
//
// 数据卫生：本插件不写应用侧任何用户数据（不改标签/元数据/收藏/叠加态，不用临时选区中转），
// 只读选中列表与素材详情，改动全部发生在 REAPER 工程内。
//
// v1.1.3：右键菜单显示文案改短（仅菜单显示，命令标题/插件名不动）。
// v1.1.4：修复「多选只发出一条」——collectSelection() 增加读取宿主权威多选字段
//   primaryId / multiSelectedIds（宿主多选时勾选行出现在 multiSelectedIds，主预览行在
//   primaryId，不能只依赖 all；宿主某次只回传单个 all 时就会漏发勾选行）。新来源与既有
//   来源合并去重，其余逻辑与对外契约（权限/菜单/命令/快捷键/调用方式）全部不变。
// v1.1.5：补齐 v1.1.4 未覆盖的一类选中形态——AI 生成收件箱等「未入库文件」在宿主
//   get_selected_sounds 里被放进 onlineSelected，且 freesoundId / previewUrl 均为 null。
//   旧逻辑一律按在线素材处理、因缺 freesoundId 直接跳过，于是用户看到「多选只发出一条」。
//   现改为：既无 freesoundId 又无 previewUrl 的条目，先用文件名回查当前页签
//   (get_current_view_sounds) 条目里的 absolutePath，命中则改走「未入库文件按路径直发」；
//   反查不到才跳过，且跳过原因按「在线素材缺预览链接」/「收件箱文件缺磁盘路径」分开写明。
//   同时按「规范化绝对路径」做跨桶去重（宿主会把同一文件的记录同时报进 pathSelected 与
//   onlineSelected，不去重会让同一文件在同一位置插两条）；按文件名去重是禁止的
//   （收件箱同名不同版本是常态）。对外契约（权限/菜单/命令/快捷键/工具名与描述）全部不变。

export const manifest = {
  id: "send-to-reaper-cursor",
  name: "发送到 REAPER 光标位置",
  version: "1.1.5",
  author: "SFX Reactor AI",
  description:
    "在素材列表右键菜单增加「发送到 REAPER 光标位置」：把当前选中素材（支持多选）插入到 REAPER 当前编辑光标位置，逐条汇报成功/失败。支持本地素材、此电脑/收件箱等未入库文件（按路径直发）与 Freesound 在线素材（自动下载原始文件到缓存后插入，不入素材库）。",
  entryPoint: "script.js",
  permissions: ["read_library", "reaper_control"],
  tags: ["reaper", "context-menu", "send"],
};

// AI 工具名（下轮工具清单刷新后可见）
const TOOL_NAME = "plugin.send-to-reaper-cursor.send_to_cursor";
const MENU_ID = "plugin.send-to-reaper-cursor.menu";
const MENU_LABEL = "发送到 REAPER 光标位置";
// 右键菜单显示用短名：只作用于菜单文案，不影响命令标题（registerCommand.title 仍用 MENU_LABEL）
const MENU_LABEL_SHORT = "发送到reaper";
// 命令 id：让「发送到 REAPER 光标位置」可注册为带快捷键的命令（设置「快捷键」页签可见）
const COMMAND_ID = "plugin.send-to-reaper-cursor.send_command";
// 快捷键键位：唯一来源。右键菜单文案与命令 shortcut 都引用它，避免两处硬编码漂移。
const SHORTCUT = "Ctrl+Shift+R";
// 右键菜单显示文案：短名 + 键盘符号，便于用户一眼看出有键位可用
const MENU_LABEL_DISPLAY = MENU_LABEL_SHORT + "（" + SHORTCUT + "）";
// 内置 REAPER 类工具：把本地素材插入到 REAPER 编辑光标处（经 reaper_control 权限桥接）
const SEND_TOOL = "send_to_reaper";

// 运行环境不提供全局 plugin 对象，必须在 init(pluginCtx) 里自行保存引用
let ctx = null;
let busy = false;

/* ---------------- 通用小工具 ---------------- */

function requireCtx() {
  if (!ctx || typeof ctx.callTool !== "function") {
    throw new Error("插件上下文未就绪");
  }
  return ctx;
}

function pick(obj, keys) {
  if (!obj) return undefined;
  for (let i = 0; i < keys.length; i++) {
    const v = obj[keys[i]];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function toast(msg, type) {
  try {
    if (ctx && typeof ctx.showToast === "function") ctx.showToast(msg, type || "info");
  } catch (e) {
    /* 提示失败不阻断主流程 */
  }
}

// 只接受本地素材库的数值 id；AI 收件箱等给的是文件路径字符串，不是本地 id
function toLocalId(raw) {
  if (typeof raw === "number" && isFinite(raw)) return raw;
  if (typeof raw === "string" && /^[0-9]+$/.test(raw.trim())) return Number(raw.trim());
  return null;
}

function nameOf(rec, fallback) {
  const n = pick(rec, ["fileName", "filename", "name", "title"]);
  return n === undefined ? fallback : String(n);
}

function isReaperDownMessage(msg) {
  return /reaper|bridge|桥|未运行|未连接|没有连接|未启动|不可用|not\s*running|disconnected|not\s*connected/i.test(
    String(msg || "")
  );
}

/* ---------------- 文件同一性判定（去重只认「规范化绝对路径」） ---------------- */
// Windows 下大小写不敏感、正/反斜杠归一、去首尾空白；仅用于判断是否同一文件，
// 实际发送仍用宿主给的原始路径字符串。严禁按 fileName 去重：收件箱/生成素材
// 同名不同版本是常态，两条同名不同路径必须都发。
function normPathKey(p) {
  if (typeof p !== "string") return null;
  let s = p.trim();
  if (!s) return null;
  s = s.replace(/\//g, "\\").toLowerCase();
  return "f:" + s;
}

// 记录级兜底键：没有磁盘路径时退化为按记录 id 去重（避免同一条记录被多处上报而重复计数）；
// 无法判定是否重复（既无路径也无 id）时返回 null，表示「按新条目收下」。
function pathRecordKey(id, absolutePath) {
  const k = normPathKey(absolutePath);
  if (k) return k;
  if (id === null || id === undefined) return null;
  return "r:" + String(id);
}

function mergePath(list, keyMap, id, name, absolutePath) {
  const key = pathRecordKey(id, absolutePath);
  if (key && keyMap[key] !== undefined) return false;
  if (key) keyMap[key] = list.length;
  list.push({ id: id, fileName: name || String(id), absolutePath: absolutePath || null });
  return true;
}

/* ---------------- 选中素材解析（防御式：不写死宿主返回的字段名） ---------------- */

function collectSelection(data) {
  const locals = [];
  const online = [];
  const paths = [];
  const skipped = [];
  const pathKeys = Object.create(null); // 规范化绝对路径 → 已登记（跨桶同一文件只留一条）
  const seenLocal = Object.create(null);
  const seenOnline = Object.create(null);
  let rawCount = 0; // 宿主回传的选中记录条数（去重前）
  let duplicateSkipped = 0; // 因与已登记文件为同一文件而丢弃的记录数

  function addLocal(id, name) {
    const nm = name === undefined || name === null || name === "" ? null : String(name);
    const exist = seenLocal[id];
    if (exist) {
      // 已由权威 id 字段（primaryId/multiSelectedIds）占位登记、仅有「#id」占位名时，
      // 用后续记录（all 等）里的真实文件名补齐；不重复入列，保证不漏发也不多发。
      if (nm && exist.fileName === "#" + id) exist.fileName = nm;
      return;
    }
    const entry = { id: id, fileName: nm || "#" + id };
    seenLocal[id] = entry;
    locals.push(entry);
  }

  // 在线素材只按 freesoundId 做记录级去重；无 freesoundId 的条目不做名称去重
  //（同名不同路径是常态，按名去重会漏发），留给后续「按绝对路径」判定是否同一文件。
  function addOnline(rec) {
    const fid = Number(pick(rec, ["freesoundId"]));
    const hasFid = isFinite(fid) && fid > 0;
    const previewUrl = pick(rec, ["previewUrl"]);
    const name = nameOf(rec, hasFid ? "freesound:" + fid : "在线素材");
    if (hasFid) {
      if (seenOnline["fs:" + fid]) return;
      seenOnline["fs:" + fid] = true;
    }
    online.push({
      freesoundId: hasFid ? fid : null,
      previewUrl: typeof previewUrl === "string" && previewUrl ? previewUrl : null,
      fileName: name,
    });
  }

  function addPath(id, name, absolutePath) {
    if (!mergePath(paths, pathKeys, id, name, absolutePath)) duplicateSkipped++;
  }

  function visit(rec, forceOnline) {
    if (!rec || typeof rec !== "object") return;
    rawCount++;
    const rawId = pick(rec, ["id", "soundId"]);
    const id = toLocalId(rawId);
    if (id !== null) {
      addLocal(id, nameOf(rec, null));
      return;
    }
    const onlineish =
      forceOnline === true ||
      rec.online === true ||
      (rec.freesoundId !== undefined && rec.freesoundId !== null) ||
      (typeof rawId === "string" && /^fs-/i.test(rawId));
    if (onlineish) {
      addOnline(rec);
      return;
    }
    if (typeof rawId === "string" && rawId) {
      // 未入库素材（此电脑/收件箱等）：有磁盘路径即可不经入库直接发送
      const abs = pick(rec, ["absolutePath"]);
      addPath(rawId, nameOf(rec, rawId), typeof abs === "string" && abs ? abs : null);
      return;
    }
  }

  const d = data && typeof data === "object" ? data : {};

  // 权威 id 来源优先（宿主多选时：主预览行在 primaryId，勾选行只出现在 multiSelectedIds；
  // 不能只依赖 all，宿主某次只回传单个 all 时会漏发勾选行）。
  // 这里先用 id 占位登记保证「不漏」，随后由 all/selected 等记录补上真实文件名。
  const primaryId = toLocalId(d.primaryId);
  if (primaryId !== null) {
    rawCount++;
    addLocal(primaryId, null);
  }
  if (Array.isArray(d.multiSelectedIds)) {
    for (const rid of d.multiSelectedIds) {
      const id = toLocalId(rid);
      if (id !== null) {
        rawCount++;
        addLocal(id, null);
      }
    }
  }

  if (Array.isArray(d.all)) for (const rec of d.all) visit(rec, false);
  if (Array.isArray(d.selected)) for (const rec of d.selected) visit(rec, false);
  else if (d.selected && typeof d.selected === "object") visit(d.selected, false);
  if (Array.isArray(d.multiSelected)) for (const rec of d.multiSelected) visit(rec, false);
  // 路径桶先收（它的 absolutePath 是权威的），再收在线桶，跨桶同一文件时保留有路径的一条
  if (Array.isArray(d.pathSelected)) for (const rec of d.pathSelected) visit(rec, false);
  if (Array.isArray(d.onlineSelected)) for (const rec of d.onlineSelected) visit(rec, true);

  return {
    locals: locals,
    online: online,
    paths: paths,
    skipped: skipped,
    pathKeys: pathKeys,
    rawCount: rawCount,
    duplicateSkipped: duplicateSkipped,
  };
}

// 读当前页签条目：既拿「id → 文件名」（给 AI 显式传 id 时补可读名），
// 也拿「文件名 → 绝对路径」（给收件箱等未入库素材反查磁盘路径）。失败不影响主流程。
// 同一文件名对应多个不同路径时置为 null 并标记 ambiguous（宁可不发也不发错文件）。
async function fetchViewIndex(api) {
  const names = Object.create(null);
  const pathsByName = Object.create(null);
  const ambiguous = Object.create(null);
  try {
    const res = await api.callTool("get_current_view_sounds");
    const items =
      res && res.ok && res.data && Array.isArray(res.data.items) ? res.data.items : [];
    for (const it of items) {
      if (!it || typeof it !== "object") continue;
      const id = toLocalId(it.id);
      const fn = pick(it, ["fileName", "filename", "name"]);
      const abs = pick(it, ["absolutePath"]);
      if (id !== null) names[id] = fn === undefined ? "" : String(fn);
      if (typeof fn === "string" && fn && typeof abs === "string" && abs) {
        const exist = pathsByName[fn];
        if (exist === undefined) {
          pathsByName[fn] = abs;
        } else if (exist !== null && normPathKey(exist) !== normPathKey(abs)) {
          pathsByName[fn] = null;
          ambiguous[fn] = true;
        }
      }
    }
  } catch (e) {
    /* 反查只是兜底：拿不到就按原逻辑跳过并写明原因 */
  }
  return { names: names, pathsByName: pathsByName, ambiguous: ambiguous };
}

/* ---------------- 发送 ---------------- */

function buildSummary(inserted, failed, failedOnline, skipped, pathCount, onlineSent, duplicateSkipped, rawCount) {
  const parts = [];
  // inserted（REAPER 桥报告）是唯一权威总数：本地 id/路径/在线三路都计入，
  // 避免「没有素材被发送」与「REAPER 报告插入 1 条」同屏自相矛盾
  if (isFinite(inserted) && inserted > 0) {
    parts.push("已发送 " + inserted + " 条到 REAPER 光标位置");
  } else {
    parts.push("REAPER 没有插入任何素材");
  }
  if (pathCount > 0 && isFinite(inserted) && inserted > 0) {
    parts.push(pathCount + " 个未入库文件按路径直发");
  }
  if (onlineSent > 0) {
    parts.push(onlineSent + " 条在线素材已下载到缓存（不入素材库）");
  }
  if (duplicateSkipped > 0) {
    parts.push("选中 " + rawCount + " 条中有 " + duplicateSkipped + " 条与已选文件为同一文件，已去重");
  }
  if (failed.length) parts.push("本地素材失败 " + failed.length + " 条");
  if (failedOnline.length) parts.push("在线素材下载失败 " + failedOnline.length + " 条");
  if (skipped.length) parts.push("跳过 " + skipped.length + " 条");
  return parts.join("，");
}

async function sendLocalIds(api, locals, extras) {
  const ids = locals.map(function (l) {
    return l.id;
  });

  // 三入参一次提交：本地 id + 未入库文件路径 + 在线素材（宿主内部下载到缓存，不入库）
  const onlinePayload = [];
  for (const o of extras.online) {
    if (o.freesoundId !== null && o.previewUrl) {
      onlinePayload.push({ freesoundId: o.freesoundId, previewUrl: o.previewUrl, fileName: o.fileName });
    } else {
      extras.skipped.push({
        fileName: o.fileName,
        reason: o.freesoundId === null ? "缺少 Freesound id" : "缺少预览链接，无法下载原始文件",
      });
    }
  }
  const pathPayload = [];
  for (const p of extras.paths) {
    if (p.absolutePath) pathPayload.push(p.absolutePath);
    else
      extras.skipped.push({
        fileName: p.fileName,
        reason: "没有磁盘路径（如尚未生成的收件箱素材），无法发送",
      });
  }

  const uniqueDiskFiles = ids.length + pathPayload.length + onlinePayload.length;
  const rawReturned =
    typeof extras.rawCount === "number" ? extras.rawCount : uniqueDiskFiles;
  const duplicateSkipped = extras.duplicateSkipped || 0;

  const res = await api.callTool(SEND_TOOL, {
    soundIds: ids,
    paths: pathPayload,
    online: onlinePayload,
  });

  if (!res || res.ok !== true) {
    const raw = res && res.error ? String(res.error) : "REAPER 发送失败";
    const error = isReaperDownMessage(raw)
      ? "REAPER 未运行或桥未连接，请先打开 REAPER 后再试"
      : "发送失败：" + raw;
    return {
      ok: false,
      error: error,
      data: {
        target: SEND_TOOL,
        requested: uniqueDiskFiles,
        rawReturned: rawReturned,
        uniqueDiskFiles: uniqueDiskFiles,
        inserted: 0,
        duplicateSkipped: duplicateSkipped,
        sent: [],
        failed: locals.map(function (l) {
          return { id: l.id, fileName: l.fileName, reason: raw };
        }),
        skippedOnline: extras.online,
        skippedOther: extras.skipped,
      },
    };
  }

  const d = (res && res.data) || {};
  const missingIds = Object.create(null);
  const missingReasons = Object.create(null);
  if (Array.isArray(d.missing)) {
    for (const m of d.missing) {
      const mid = toLocalId(m && typeof m === "object" ? pick(m, ["id", "soundId"]) : m);
      if (mid === null) continue;
      missingIds[mid] = true;
      const r = m && typeof m === "object" ? pick(m, ["reason", "error"]) : undefined;
      if (r) missingReasons[mid] = String(r);
    }
  }

  const sent = [];
  const failed = [];
  for (const l of locals) {
    if (missingIds[l.id]) {
      failed.push({
        id: l.id,
        fileName: l.fileName,
        reason: missingReasons[l.id] || "REAPER 未能插入该素材",
      });
    } else {
      sent.push({ id: l.id, fileName: l.fileName });
    }
  }

  const inserted = Number(d.inserted);
  const onlineSent = Array.isArray(d.cached) ? d.cached.length : 0;
  const failedOnline = Array.isArray(d.failedOnline) ? d.failedOnline : [];
  const msg = buildSummary(
    inserted,
    failed,
    failedOnline,
    extras.skipped,
    pathPayload.length,
    onlineSent,
    duplicateSkipped,
    rawReturned
  );
  const data = {
    target: SEND_TOOL,
    requested: uniqueDiskFiles,
    rawReturned: rawReturned,
    uniqueDiskFiles: uniqueDiskFiles,
    inserted: isFinite(inserted) ? inserted : undefined,
    duplicateSkipped: duplicateSkipped,
    sent: sent,
    failed: failed,
    failedOnline: failedOnline,
    cached: Array.isArray(d.cached) ? d.cached : [],
    skippedOnline: extras.online,
    skippedOther: extras.skipped,
  };

  const requestedTotal = uniqueDiskFiles;
  if (requestedTotal > 0 && isFinite(inserted) && inserted === 0) {
    toast(msg, "error");
    return {
      ok: false,
      error:
        "全部发送失败：" +
        (failed[0] ? failed[0].reason : failedOnline[0] ? failedOnline[0].error : "REAPER 未能插入任何素材"),
      data: data,
    };
  }

  toast(msg, failed.length || failedOnline.length ? "warning" : "info");
  return { ok: true, data: data };
}

async function runSend(source, soundIds) {
  const api = requireCtx();

  if (busy) {
    toast("正在发送中，请稍候…", "warning");
    return { ok: false, error: "正在发送中，请稍候" };
  }
  busy = true;

  try {
    let locals = [];

    if (Array.isArray(soundIds) && soundIds.length) {
      // AI 显式指定了素材 id：不再读选中列表
      const seen = Object.create(null);
      const view = await fetchViewIndex(api);
      for (const raw of soundIds) {
        const id = toLocalId(raw);
        if (id === null || seen[id]) continue;
        seen[id] = true;
        locals.push({ id: id, fileName: view.names[id] || "#" + id });
      }
      if (!locals.length) {
        const m = "没有可发送的本地素材 id（需要本地素材库素材）";
        toast(m, "warning");
        return { ok: false, error: m };
      }
      return await sendLocalIds(api, locals, {
        online: [],
        paths: [],
        skipped: [],
        rawCount: locals.length,
        duplicateSkipped: 0,
      });
    }

    // 菜单/工具缺省：取当前选中（支持多选；本地 id + 未入库路径 + 在线素材一次提交）
    const selRes = await api.callTool("get_selected_sounds");
    if (!selRes || selRes.ok !== true) {
      const raw = selRes && selRes.error ? String(selRes.error) : "读取选中素材失败";
      toast("读取选中素材失败：" + raw, "error");
      return { ok: false, error: raw };
    }
    const sel = collectSelection(selRes.data);
    locals = sel.locals;
    const skipped = sel.skipped;
    const selPaths = sel.paths;
    const pathKeys = sel.pathKeys;
    let duplicateSkipped = sel.duplicateSkipped;
    const rawCount = sel.rawCount;

    // 分拣宿主的「在线」桶：
    //  - 有 freesoundId + previewUrl：真在线素材，走下载原始文件；
    //  - 只有其一：无法下载，跳过并写明是哪一项缺失；
    //  - 两者皆无：通常不是在线素材，而是 AI 生成收件箱等未入库文件——宿主只给了文件名，
    //    用文件名回查当前页签的绝对路径，命中则改走「未入库文件按路径直发」，
    //    并按规范化路径与路径桶跨桶去重（同一文件只发一条）。
    const onlineReady = [];
    const needPath = [];
    for (const o of sel.online) {
      const hasFid = o.freesoundId !== null;
      const hasUrl = o.previewUrl !== null;
      if (hasFid && hasUrl) {
        onlineReady.push(o);
      } else if (hasFid) {
        skipped.push({
          fileName: o.fileName,
          reason: "在线素材（freesound:" + o.freesoundId + "）缺少预览链接，无法下载原始文件",
        });
      } else if (hasUrl) {
        skipped.push({ fileName: o.fileName, reason: "在线素材缺少 Freesound id，无法下载原始文件" });
      } else {
        needPath.push(o);
      }
    }

    if (needPath.length) {
      const view = await fetchViewIndex(api);
      for (const o of needPath) {
        const hit = view.pathsByName[o.fileName];
        if (typeof hit === "string" && hit) {
          if (!mergePath(selPaths, pathKeys, o.fileName, o.fileName, hit)) duplicateSkipped++;
        } else if (view.ambiguous[o.fileName]) {
          skipped.push({
            fileName: o.fileName,
            reason: "当前页签内有多条同名但路径不同的文件，无法确定是哪一条，未发送",
          });
        } else {
          skipped.push({
            fileName: o.fileName,
            reason: "收件箱文件缺磁盘路径（当前页签未提供该文件的绝对路径），无法发送",
          });
        }
      }
    }

    const pathSendable = selPaths.filter(function (p) {
      return p.absolutePath;
    });

    if (!locals.length && !onlineReady.length && !pathSendable.length) {
      let m;
      if (skipped.length) {
        m =
          "选中的素材无法发送：" +
          skipped[0].reason +
          (skipped.length > 1 ? "（共 " + skipped.length + " 条）" : "");
      } else if (sel.online.length) {
        m = "选中的是 Freesound 在线素材，但缺少预览链接，无法下载原始文件（可重新搜索后发送）";
      } else {
        m = "请先选择要发送的素材";
      }
      toast(m, "warning");
      return {
        ok: false,
        error: m,
        data: {
          rawReturned: rawCount,
          uniqueDiskFiles: 0,
          inserted: 0,
          duplicateSkipped: duplicateSkipped,
          onlineBucket: sel.online,
          skippedOther: skipped,
        },
      };
    }

    if (locals.length + pathSendable.length + onlineReady.length > 50) {
      toast(
        "已选中 " + (locals.length + pathSendable.length + onlineReady.length) + " 条素材，正在发送，请稍候…",
        "warning"
      );
    }

    return await sendLocalIds(api, locals, {
      online: onlineReady,
      paths: selPaths,
      skipped: skipped,
      rawCount: rawCount,
      duplicateSkipped: duplicateSkipped,
    });
  } catch (e) {
    const raw = e && e.message ? e.message : String(e);
    toast("发送失败：" + raw, "error");
    return { ok: false, error: raw };
  } finally {
    busy = false;
  }
}

/* ---------------- 插件入口 ---------------- */

export async function init(pluginCtx) {
  ctx = pluginCtx;

  await pluginCtx.registerTool(
    {
      name: TOOL_NAME,
      description:
        "把素材发送/插入到 REAPER 当前编辑光标位置；未提供参数时使用当前选中的素材（本地、此电脑/收件箱未入库文件、Freesound 在线素材都支持，在线素材自动下载原始文件到缓存、不入素材库）。用户说「发送到 REAPER 光标位置」「把选中的素材送到 REAPER 光标处」时使用。",
      parameters: {
        type: "object",
        properties: {
          soundIds: {
            type: "array",
            items: { type: "number" },
            description: "要发送的本地素材数值 id 数组；缺省取当前选中的素材",
          },
        },
      },
    },
    async function (args) {
      return await runSend("tool", args && args.soundIds);
    }
  );

  if (typeof pluginCtx.registerContextMenu === "function") {
    pluginCtx.registerContextMenu({
      id: MENU_ID,
      // 菜单文案：短名 + 快捷键字符（与命令 shortcut 同源同常量，不硬编码两处）
      label: MENU_LABEL_DISPLAY,
      separatorBefore: true,
      // 宽松形式：仅当宿主明确给出 count === 0 时隐藏，避免上下文形状差异导致菜单项永不出现
      canShow: function (context) {
        return context && typeof context.count === "number" ? context.count >= 1 : true;
      },
      // onClick 不依赖未文档化的回调参数，一律内部重新取选中
      onClick: function () {
        void runSend("menu");
      },
    });
  }

  // 命令 + 快捷键：让「发送到 REAPER 光标位置」可按键盘触发（设置「快捷键」页签会列出它）。
  // 沿用 registerContextMenu 的 typeof 防御写法，兼容不认识 registerCommand 的旧宿主。
  if (typeof pluginCtx.registerCommand === "function") {
    pluginCtx.registerCommand({
      id: COMMAND_ID,
      title: MENU_LABEL,
      shortcut: SHORTCUT,
      run: function () {
        void runSend("command");
      },
    });
  }
}

export function unload() {
  busy = false;
  ctx = null;
}
