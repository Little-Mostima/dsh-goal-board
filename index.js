/**
 * dsh-goal-board — 跨会话目标清单（项目 → 目标 → 条目）。
 *
 * 三件事：
 *  1. 每轮把当前项目的清单快照塞进上下文（动态 context，尾部追加，压缩后自动补回）。
 *  2. 给 agent 两个工具：读清单、改清单（加条目/改状态/调顺序/完成归档）。
 *  3. 给面板一个本机 API：拖动调优先级、搁置/恢复、看归档。
 *
 * 数据存在 DSH_HOME/goal-board/data.json，跟软件一起备份。
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export const name = 'dsh-goal-board';
export const inject = ['tools', 'systemPrompt'];

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const DATA_DIR = path.join(HOME, 'goal-board');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const TOMB_FILE = path.join(DATA_DIR, 'tombstones.json');
const API_PREFIX = '/goal-board/api';
const API_TOKEN = randomBytes(24).toString('hex');
const INDEX_GLOBAL = '__DSH_GOAL_BOARD__';
const MAX_BODY = 64 * 1024;

const ITEM_STATUSES = ['todo', 'doing', 'done', 'blocked'];
const GOAL_STATUSES = ['active', 'suspended', 'done'];

/** @type {{version:number, projects:any[], archive:any[]}} */
let data = { version: 1, projects: [], archive: [], tombstones: [], sessions: {} };
let saveChain = Promise.resolve();
/** @type {null | ((session:any)=>string|null)} */
let wdGet = null;

// ---------------------------------------------------------------- 基础工具

function newId(prefix) {
  return prefix + '_' + randomUUID().slice(0, 8);
}

function normPath(p) {
  if (typeof p !== 'string' || !p.trim()) return '';
  let s = path.resolve(p.trim());
  if (process.platform === 'win32') s = s.toLowerCase();
  return s.replace(/[\\/]+$/, '');
}

function isUnder(folder, cwd) {
  const f = normPath(folder);
  const c = normPath(cwd);
  if (!f || !c) return false;
  return c === f || c.startsWith(f + path.sep) || c.startsWith(f + '/');
}

/** 当前会话的身份：短 id 用来在清单里标"谁在处理"。 */
function sessionInfo(agent) {
  const session = agent?.session;
  const header = session?.header ?? {};
  const id = String(header.id ?? session?.id ?? '');
  return { id, label: id ? id.slice(-6) : '未知会话' };
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function claimItem(item, agent) {
  const me = sessionInfo(agent);
  item.owner = { sessionId: me.id, label: me.label, at: nowStamp(), ts: Date.now() };
}

function releaseItem(item) {
  item.owner = null;
}

// 认领有"心跳"：会话每次调模型、注入渲染时续期一次。超过 TTL 没续期就算失联——
// 失联的认领会被自动释放（条目退回「排队中」），会话半路没了也不会一直占着卡片。
// TTL 默认 30 分钟；调试时可用 DSH_GOAL_BOARD_TTL_MS 覆盖。
const OWNER_TTL_MS = Number(process.env.DSH_GOAL_BOARD_TTL_MS) > 0
  ? Number(process.env.DSH_GOAL_BOARD_TTL_MS)
  : 30 * 60 * 1000;

function isStaleOwner(owner) {
  if (!owner?.sessionId) return false;
  if (!owner.ts) return true;
  return Date.now() - Number(owner.ts) > OWNER_TTL_MS;
}

// 自动释放：认领超过 TTL 没心跳就自己摘掉，条目退回「排队中」，
// 不用人点徽章——会话半路没了（关窗、崩、换任务），卡片不该一直挂着。
// 顺手把「已完成且填了产出指针」的目标归档并从清单删掉，面板上不留已完成的卡。
function sweepStaleClaims() {
  let changed = false;
  for (const project of data.projects ?? []) {
    for (const goal of project.goals ?? []) {
      for (const item of goal.items ?? []) {
        if (!item.owner || !isStaleOwner(item.owner)) continue;
        item.owner = null;
        if (item.status === 'doing') item.status = 'todo';
        changed = true;
      }
    }
    const archived = (project.goals ?? []).filter((g) => g.status === 'done' && g.pointer);
    if (archived.length > 0) {
      for (const goal of archived) archiveGoal(project, goal, goal.pointer);
      project.goals = project.goals.filter((g) => !archived.includes(g));
      changed = true;
    }
  }
  if (changed) save().catch(() => {});
  return changed;
}

function touchClaims(project, meId) {
  if (!meId) return;
  const now = Date.now();
  let changed = false;
  for (const goal of project.goals ?? []) {
    for (const item of goal.items ?? []) {
      if (item.status !== 'doing' || item.owner?.sessionId !== meId) continue;
      if (!item.owner.ts || now - Number(item.owner.ts) > 60_000) {
        item.owner.ts = now;
        item.owner.at = nowStamp();
        changed = true;
      }
    }
  }
  if (changed) save().catch(() => {});
}

/** 把某个会话（默认：本会话）在这些条目上的认领摘掉。 */
function releaseClaims(project, { sessionId, goalId, itemId }) {
  let removed = 0;
  for (const goal of project.goals ?? []) {
    if (goalId && goal.id !== goalId) continue;
    for (const item of goal.items ?? []) {
      if (itemId && item.id !== itemId) continue;
      if (!item.owner?.sessionId) continue;
      if (sessionId && item.owner.sessionId !== sessionId) continue;
      item.owner = null;
      removed += 1;
    }
  }
  return removed;
}

/** 会话存活登记：每轮注入都会刷新，用来回答"哪些会话在跑、有没有记账"。 */
const SESSION_KEEP_MS = 2 * 60 * 60 * 1000;

function hasCardFor(project, meId) {
  if (!project || !meId) return false;
  return (project.goals ?? []).some(
    (g) => g.createdBy === meId || (g.items ?? []).some((i) => i.owner?.sessionId === meId),
  );
}

function touchSession(agent, cwd, hasCard) {
  const me = sessionInfo(agent);
  if (!me.id) return;
  if (!data.sessions || typeof data.sessions !== 'object') data.sessions = {};
  const now = Date.now();
  const rec = data.sessions[me.id] ?? { id: me.id, firstSeen: now, turns: 0 };
  rec.label = me.label;
  rec.cwd = cwd || rec.cwd || '';
  rec.turns = (rec.turns || 0) + 1;
  rec.lastSeen = now;
  rec.hasCard = !!hasCard;
  data.sessions[me.id] = rec;
  for (const [id, r] of Object.entries(data.sessions)) {
    if (!r?.lastSeen || now - r.lastSeen > SESSION_KEEP_MS) delete data.sessions[id];
  }
  save().catch(() => {});
}

/** 最近 2 小时还活着的会话，新的在前。 */
function recentSessions(limit = 12) {
  const cutoff = Date.now() - SESSION_KEEP_MS;
  return Object.values(data.sessions ?? {})
    .filter((r) => r && r.lastSeen > cutoff)
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, limit);
}

function findProjectByCwd(cwd) {
  let best = null;
  let bestLen = -1;
  for (const project of data.projects) {
    for (const folder of project.folders || []) {
      if (!isUnder(folder, cwd)) continue;
      const len = normPath(folder).length;
      if (len > bestLen) {
        best = project;
        bestLen = len;
      }
    }
  }
  return best;
}

function projectRef(ref) {
  if (!ref) return null;
  const needle = String(ref).trim().toLowerCase();
  return (
    data.projects.find((p) => p.id === ref) ||
    data.projects.find((p) => String(p.name).toLowerCase() === needle) ||
    data.projects.find((p) => String(p.name).toLowerCase().includes(needle)) ||
    null
  );
}

function goalRef(project, ref) {
  if (!project || !ref) return null;
  const needle = String(ref).trim().toLowerCase();
  return (
    project.goals.find((g) => g.id === ref) ||
    project.goals.find((g) => String(g.title).toLowerCase() === needle) ||
    project.goals.find((g) => String(g.title).toLowerCase().includes(needle)) ||
    null
  );
}

function itemRef(goal, ref) {
  if (!goal || !ref) return null;
  const needle = String(ref).trim().toLowerCase();
  return (
    goal.items.find((i) => i.id === ref) ||
    goal.items.find((i) => String(i.text).toLowerCase() === needle) ||
    goal.items.find((i) => String(i.text).toLowerCase().includes(needle)) ||
    null
  );
}

function cwdOf(exec) {
  const session = exec?.agent?.session;
  if (session && wdGet) {
    try {
      const dir = wdGet(session);
      if (dir) return dir;
    } catch {
      /* ignore */
    }
  }
  return session?.header?.cwd ?? process.cwd();
}

function resolveProject(ref, exec) {
  if (ref) return projectRef(ref);
  return findProjectByCwd(cwdOf(exec));
}

// ---------------------------------------------------------------- 持久化

async function load() {
  try {
    const raw = await readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.projects)) {
      data = {
        version: 1,
        projects: parsed.projects,
        archive: Array.isArray(parsed.archive) ? parsed.archive : [],
        tombstones: Array.isArray(parsed.tombstones) ? parsed.tombstones : [],
        sessions: parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
      };
      for (const project of data.projects) {
        for (const goal of project.goals ?? []) {
          for (const item of goal.items ?? []) {
            if (item.owner === undefined) item.owner = null;
          }
          normalizeGoal(goal);
        }
      }
    }
  } catch (e) {
    if (e?.code !== 'ENOENT') {
      console.warn('[dsh-goal-board] 读取清单失败：' + String(e?.message ?? e));
    }
  }
  try {
    const raw = await readFile(TOMB_FILE, 'utf8');
    const list = JSON.parse(raw);
    if (Array.isArray(list)) data.tombstones = list;
  } catch {
    /* 还没有墓碑文件 */
  }
}

function save() {
  // 墓碑单独存一个文件：删掉的卡不能被后来的保存覆盖掉。
  const { tombstones, ...rest } = data;
  const snapshot = JSON.stringify(rest, null, 2);
  saveChain = saveChain
    .then(async () => {
      await mkdir(DATA_DIR, { recursive: true });
      await writeFile(DATA_FILE, snapshot, 'utf8');
    })
    .catch((e) => {
      console.warn('[dsh-goal-board] 保存清单失败：' + String(e?.message ?? e));
    });
  return saveChain;
}

function saveTombstones() {
  const snapshot = JSON.stringify(data.tombstones ?? [], null, 2);
  return writeFile(TOMB_FILE, snapshot, 'utf8').catch((e) => {
    console.warn('[dsh-goal-board] 保存墓碑失败：' + String(e?.message ?? e));
  });
}

// ---------------------------------------------------------------- 渲染

function itemLine(item, index, focusId, meId) {
  let tag = item.status;
  if (item.status === 'doing') {
    const owner = item.owner;
    if (owner?.sessionId && meId && owner.sessionId !== meId) {
      tag = isStaleOwner(owner)
        ? `doing·空闲会话「${owner.label}」的认领（可直接接手）`
        : `doing·其他会话「${owner.label}」处理中`;
    } else if (item.id === focusId) tag = 'doing·当前焦点';
  }
  const note = item.note ? ` —— 备注：${item.note}` : '';
  return `  ${index + 1}. [${tag}] ${item.text}${note}`;
}

/** 注入用的紧凑快照：只列没做完的，已完成折成计数。 */
function renderInjection(agent) {
  const session = agent?.session;
  let cwd = session?.header?.cwd;
  if (session && wdGet) {
    try {
      cwd = wdGet(session) || cwd;
    } catch {
      /* ignore */
    }
  }
  if (!cwd) return '';

  sweepStaleClaims();
  const project = findProjectByCwd(cwd);
  if (!project) {
    touchSession(agent, cwd, false);
    return `【目标清单】你正在 ${cwd} 干活，但这个文件夹还没归属任何项目——现在你做的事用户在清单上看不到。动手前先调一次 goal_board_update：这个目录属于已有项目就用 bind_folder 归过去，不属于就直接 add_goal（会按文件夹名「${path.basename(cwd)}」自动建项目）。这一步不能跳过，做完再继续手上的活。`;
  }

  const meId = sessionInfo(agent).id;
  touchClaims(project, meId);
  const mine = hasCardFor(project, meId);
  touchSession(agent, cwd, mine);

  const active = project.goals.filter((g) => g.status === 'active');
  const suspended = project.goals.filter((g) => g.status === 'suspended');
  const pendingArchive = project.goals.filter((g) => g.status === 'done' && !g.pointer);
  // 用户手动删掉的目标：agent 不许重建、不许接着做。
  const tombstones = (data.tombstones ?? []).filter((t) => t.projectId === project.id).slice(-6);
  const tombLine = tombstones.length
    ? `已删除的目标（用户手动删的，不要重建、不要接着做）：${tombstones.map((t) => `「${t.title}」`).join('、')}`
    : '';
  if (active.length === 0 && suspended.length === 0) {
    if (pendingArchive.length > 0) {
      return (
        (tombLine ? tombLine + '\n' : '') +
        `【目标清单】项目「${project.name}」没有进行中的目标；待归档（已完成但缺产出指针）：` +
        pendingArchive.map((g) => `「${g.title}」`).join('、') +
        '。这轮收工前核对它们的实际产出，用 complete_goal 填产出指针归档。'
      );
    }
    return (
      (tombLine ? tombLine + '\n' : '') +
      `【目标清单】项目「${project.name}」还没有进行中的目标。你现在要动手就直接 goal_board_update add_goal 开一张卡（不用问用户），doneWhen 写清怎样算做完。`
    );
  }

  const lines = [`【目标清单】项目：${project.name}`];
  if (tombLine) lines.push(tombLine);
  if (!mine) {
    lines.push(
      `⚠ 本会话（${sessionInfo(agent).label}）在清单里还没有任何记录——先 goal_board_update add_goal 开一张卡（不用问用户），把现在手上的活写成条目，再继续。没有卡 = 用户看不到你做到哪了。`,
    );
  }
  const focus = active[0];
  if (focus) {
    lines.push(`主攻目标：${focus.title}（怎样算做完：${focus.doneWhen || '未填写'}）`);
    const open = focus.items.filter((i) => i.status !== 'done');
    const doneCount = focus.items.length - open.length;
    const focusItem = open.find((i) => i.status === 'doing');
    open.forEach((item, index) => lines.push(itemLine(item, index, focusItem?.id, meId)));
    if (doneCount > 0) lines.push(`  （已完成 ${doneCount} 条）`);
    if (open.length === 0) lines.push('  （条目都做完了，可以标完成——记得填产出指针）');
    if (focus.items.length >= 10) {
      lines.push(`  ⚠ 这张卡已经 ${focus.items.length} 条，要是其实是几件事，建议拆成几张卡（先问用户）。`);
    }
  }

  const claimedElsewhere = project.goals
    .flatMap((g) => g.items)
    .filter(
      (i) =>
        i.status === 'doing' &&
        i.owner?.sessionId &&
        i.owner.sessionId !== meId &&
        !isStaleOwner(i.owner),
    );
  if (claimedElsewhere.length > 0) {
    lines.push(
      `⚠ 有 ${claimedElsewhere.length} 条正被其他会话处理（${claimedElsewhere
        .map((i) => `「${i.owner.label}」`)
        .join('、')}），别碰；要接手先问用户。`,
    );
  }

  const others = active.slice(1);
  if (others.length > 0) {
    lines.push(
      '其他进行中目标：' +
        others
          .map((g) => {
            const left = g.items.filter((i) => i.status !== 'done').length;
            return left === 0 ? `${g.title}（条目已做完，待填产出指针归档）` : `${g.title}（还剩 ${left} 条）`;
          })
          .join('、'),
    );
  }
  if (suspended.length > 0) {
    lines.push('搁置中：' + suspended.map((g) => g.title).join('、'));
  }
  if (pendingArchive.length > 0) {
    lines.push('待归档（已完成但缺产出指针）：' + pendingArchive.map((g) => `「${g.title}」`).join('、'));
    lines.push(
      '→ 这轮收工前顺手核对它们的实际产出，用 complete_goal 填产出指针归档；核不出产出的就在对话里说明，别硬填。',
    );
  }

  const otherProjects = data.projects.filter(
    (p) => p.id !== project.id && p.goals.some((g) => g.status === 'active'),
  );
  if (otherProjects.length > 0) {
    lines.push(
      '其他项目：' +
        otherProjects
          .map((p) => `${p.name}（${p.goals.filter((g) => g.status === 'active').length} 个目标进行中）`)
          .join('、'),
    );
  }

  lines.push(
    '规则：按清单顺序做；要跳序必须在对话里说明理由；做完一条把下一条标 doing；目标完成必须填产出指针（归档后从清单删除）；清单里没有对应的卡就直接 add_goal 开一张（不用问用户），只有删除目标、改别人正在做的卡、归档前才先问用户。',
    '一张卡只放同一件事：换主题（哪怕同一个项目里的另一件事）就 add_goal 开新卡，别往现有卡里塞；一张卡超过 10 条时回头看是不是该拆成几张。',
    '记账纪律（每轮照做，别等用户催）：开工前先调 goal_board_update 把要做的条目标 doing（自动挂上本会话，面板「正在进行」可见）；做完立刻标 done 并在 note 里写一句结果；收工前核对一遍——动过手但清单没变，等于这轮没记账。',
  );
  return lines.join('\n');
}

const GOAL_STATUS_LABEL = { active: '进行中', suspended: '搁置', done: '已完成' };

/** 工具输出用的完整清单：带 id，方便 agent 精确引用。 */
function renderFull(project) {
  const lines = [`项目：${project.name}（id: ${project.id}）`];
  if (project.folders?.length) lines.push(`文件夹：${project.folders.join('、')}`);
  if (project.goals.length === 0) lines.push('（还没有目标）');

  for (const goal of project.goals) {
    const head = `目标 ${goal.id}：${goal.title} [${GOAL_STATUS_LABEL[goal.status] ?? goal.status}]`;
    lines.push(head);
    if (goal.doneWhen) lines.push(`  怎样算做完：${goal.doneWhen}`);
    if (goal.status === 'done') {
      lines.push(`  完成时间：${goal.completedAt ?? '未知'}`);
      lines.push(`  产出指针：${goal.pointer ?? '（未填）'}`);
    }
    const focusItem = goal.items.find((i) => i.status === 'doing');
    for (const item of goal.items) {
      const tag = item.status === 'doing' && item.id === focusItem?.id ? 'doing·当前焦点' : item.status;
      const note = item.note ? ` 备注：${item.note}` : '';
      lines.push(`  - ${item.id} [${tag}] ${item.text}${note}`);
    }
    if (goal.items.length === 0) lines.push('  （没有条目）');
  }
  return lines.join('\n');
}

function renderArchive(projectId) {
  const rows = data.archive.filter((a) => !projectId || a.projectId === projectId);
  if (rows.length === 0) return '（归档为空）';
  return rows
    .slice(-50)
    .reverse()
    .map((a) => `- ${a.completedAt} ${a.goalTitle}（${a.projectName}）→ ${a.pointer}`)
    .join('\n');
}

// ---------------------------------------------------------------- 变更

function attachFolder(project, folder) {
  const target = normPath(folder);
  if (target && !project.folders.some((f) => normPath(f) === target)) project.folders.push(folder);
}

function ensureProject(ref, exec, { create = false, name = '' } = {}) {
  const existing = resolveProject(ref, exec);
  if (existing) return existing;
  if (!create) return null;
  // 没有指定项目、也没指定名字时，按当前工作目录自动开一个项目——
  // 换个工作区开工不该先停下来问"归到哪个项目"。
  const autoFolder = !ref && !name ? cwdOf(exec) : '';
  const project = {
    id: newId('p'),
    name: name || ref || (autoFolder ? path.basename(autoFolder) : '') || '未命名项目',
    folders: autoFolder ? [autoFolder] : [],
    goals: [],
  };
  data.projects.push(project);
  return project;
}

function ensureGoal(project, ref, { create = false, title = '', doneWhen = '', by = null } = {}) {
  const existing = goalRef(project, ref);
  if (existing) return existing;
  if (!create) return null;
  const goal = {
    id: newId('g'),
    title: title || ref || '未命名目标',
    doneWhen: doneWhen || '',
    status: 'active',
    items: [],
    completedAt: null,
    pointer: null,
    // 哪张卡是哪个会话开的：面板要能回答"这个卡是谁在推进"。
    createdBy: by || null,
  };
  project.goals.push(goal);
  return goal;
}

function autoAdvance(goal, agent) {
  if (goal.status !== 'active') return;
  if (goal.items.some((i) => i.status === 'doing')) return;
  const next = goal.items.find((i) => i.status === 'todo');
  if (next) {
    next.status = 'doing';
    if (agent) claimItem(next, agent);
  }
}

// 条目全做完 → 目标状态转 done（产出指针留空，归档前必须补）。
function normalizeGoal(goal) {
  if (goal.status !== 'active') return;
  if (!goal.items.length) return;
  if (!goal.items.every((i) => i.status === 'done')) return;
  goal.status = 'done';
  goal.completedAt = goal.completedAt || new Date().toISOString().slice(0, 10);
}

function archiveGoal(project, goal, pointer) {
  goal.status = 'done';
  goal.completedAt = goal.completedAt || new Date().toISOString().slice(0, 10);
  goal.pointer = pointer;
  if (!data.archive.some((row) => row.goalId === goal.id)) {
    data.archive.push({
      projectId: project.id,
      projectName: project.name,
      goalId: goal.id,
      goalTitle: goal.title,
      completedAt: goal.completedAt,
      pointer,
    });
  }
}

// 用户手动删掉的目标留个墓碑：注入时告诉 agent 别再重建、别再接着做。
function tombstone(project, goal) {
  data.tombstones = data.tombstones ?? [];
  if (data.tombstones.some((t) => t.goalId === goal.id)) return;
  data.tombstones.push({
    projectId: project.id,
    goalId: goal.id,
    title: goal.title,
    deletedAt: nowStamp(),
  });
  if (data.tombstones.length > 20) data.tombstones = data.tombstones.slice(-20);
  saveTombstones();
}

// ---------------------------------------------------------------- 工具

// 两个工具都只回一段文本，输出声明和渲染一样，抽出来别抄两遍。
const TEXT_RESULT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string', required: true } },
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
};

function readTool(defineTool) {
  return defineTool({
    name: 'goal_board_read',
    description:
      'Read the goal board (目标清单) of the current project or a named project: goals, their items, statuses, notes, and optionally the archive. Use it when you need exact ids or the full picture; the compact snapshot is already injected every turn.',
    parameters: {
      project: {
        type: 'string',
        description: 'Project id or name. Omit to use the project of the current folder.',
      },
      includeArchive: {
        type: 'boolean',
        description: 'Also list archived (finished) goals.',
      },
    },
    output: TEXT_RESULT,
    timeoutMs: 10_000,
    isConcurrencySafe() {
      return true;
    },
    async execute(args, exec) {
      const project = resolveProject(args.project, exec);
      if (!project) {
        return {
          text:
            `没有找到项目。当前文件夹：${cwdOf(exec)}。` +
            '先问用户归到哪个项目，或用 goal_board_update action=create_project 新建。',
        };
      }
      let text = renderFull(project);
      if (args.includeArchive) text += '\n\n归档：\n' + renderArchive(project.id);
      return { text };
    },
  });
}

function updateTool(defineTool) {
  return defineTool({
    name: 'goal_board_update',
    description: [
      'Update the goal board (目标清单). One action per call.',
      'Actions: add_item, update_item, delete_item, reorder_items, add_goal, update_goal, complete_goal, suspend_goal, resume_goal, delete_goal, bind_folder, create_project.',
      'Rules: list order = execution order; when an item is marked done the next todo becomes doing automatically; complete_goal REQUIRES a non-empty pointer (asset path / commit / doc link) and REMOVES the goal from the board (archived); add_goal and delete_goal are only allowed after the user explicitly agreed (delete_goal needs confirm:true).',
      'One goal = one piece of work. When a new topic comes up, add_goal for it instead of stuffing unrelated items into an existing goal.',
      'Sections on the panel: 正在进行 = a session is working on it (has a doing item with owner); 排队中 = active but no session yet; 搁置 = suspended. Finished goals are archived and disappear from the board.',
      'Claiming: marking an item doing claims it for this session; another session\'s claim is refused unless force:true (ask the user first). A claim with no heartbeat for 30 minutes is released automatically and the item goes back to 排队中.',
      'Returns the updated board text.',
    ].join(' '),
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: [
          'add_item',
          'update_item',
          'delete_item',
          'reorder_items',
          'add_goal',
          'update_goal',
          'complete_goal',
          'suspend_goal',
          'resume_goal',
          'delete_goal',
          'bind_folder',
          'create_project',
        ],
        description: 'What to do.',
      },
      project: {
        type: 'string',
        description: 'Project id or name. Omit to use the project of the current folder.',
      },
      goal: {
        type: 'string',
        description: 'Goal id or title (required for item/goal actions).',
      },
      item: {
        type: 'string',
        description: 'Item id or text (required for update_item).',
      },
      text: {
        type: 'string',
        description: 'Item text for add_item, or new text for update_item.',
      },
      status: {
        type: 'string',
        enum: ITEM_STATUSES,
        description: 'New item status: todo | doing | done | blocked.',
      },
      note: {
        type: 'string',
        description: 'Optional note for the item (empty string clears it).',
      },
      order: {
        type: 'array',
        items: { type: 'string' },
        description: 'Item ids in the new order (reorder_items).',
      },
      title: {
        type: 'string',
        description: 'Goal title for add_goal, or new title for update_goal.',
      },
      doneWhen: {
        type: 'string',
        description: 'How to tell the goal is done (add_goal / update_goal).',
      },
      pointer: {
        type: 'string',
        description: 'Output pointer for complete_goal: asset path, commit, or doc link. Required.',
      },
      folder: {
        type: 'string',
        description: 'Folder path for bind_folder / create_project.',
      },
      name: {
        type: 'string',
        description: 'Project name for create_project.',
      },
      force: {
        type: 'boolean',
        description: 'Take over an item another session is handling (only after the user agreed).',
      },
      confirm: {
        type: 'boolean',
        description: 'Required true for delete_goal / delete_item: confirms the user agreed to delete.',
      },
    },
    output: TEXT_RESULT,
    timeoutMs: 10_000,
    isConcurrencySafe() {
      return false;
    },
    async execute(args, exec) {
      const action = args.action;
      const project = ensureProject(args.project, exec, {
        create: action === 'create_project' || action === 'add_goal',
        name: args.name,
      });

      if (action === 'create_project') {
        if (!project) throw new Error('create_project 需要 name');
        if (args.folder) attachFolder(project, args.folder);
        await save();
        return { text: renderFull(project) };
      }

      if (!project) {
        throw new Error(
          `没有找到项目。当前文件夹：${cwdOf(exec)}。用 action=add_goal 会按这个文件夹自动建项目；要用已有项目就传 project。`,
        );
      }

      if (action === 'bind_folder') {
        if (!args.folder) throw new Error('bind_folder 需要 folder');
        attachFolder(project, args.folder);
        await save();
        return { text: renderFull(project) };
      }

      if (action === 'add_goal') {
        if (!args.title) throw new Error('add_goal 需要 title');
        if (!args.doneWhen) throw new Error('add_goal 需要 doneWhen（怎样算做完）');
        const goal = ensureGoal(project, null, {
          create: true,
          title: args.title,
          doneWhen: args.doneWhen,
          by: sessionInfo(exec.agent).id,
        });
        await save();
        return { text: renderFull(project) + `\n\n已新建目标 ${goal.id}。` };
      }

      const goal = goalRef(project, args.goal);
      if (!goal) throw new Error(`没有找到目标：${args.goal ?? '（未提供）'}`);

      switch (action) {
        case 'add_item': {
          if (!args.text) throw new Error('add_item 需要 text');
          const item = { id: newId('i'), text: args.text, status: 'todo', note: '', owner: null };
          goal.items.push(item);
          if (!goal.items.some((i) => i.status === 'doing')) {
            item.status = 'doing';
            claimItem(item, exec.agent);
          }
          break;
        }
        case 'update_item': {
          const item = itemRef(goal, args.item);
          if (!item) throw new Error(`没有找到条目：${args.item ?? '（未提供）'}`);
          if (args.text !== undefined) item.text = args.text;
          if (args.note !== undefined) item.note = args.note;
          if (args.status !== undefined) {
            if (!ITEM_STATUSES.includes(args.status)) throw new Error(`未知条目状态：${args.status}`);
            if (args.status === 'doing') {
              const me = sessionInfo(exec.agent);
              const owner = item.owner;
              if (owner?.sessionId && owner.sessionId !== me.id && !args.force && !isStaleOwner(owner)) {
                throw new Error(
                  `条目正由会话「${owner.label}」处理（${owner.at}）。要接手先问用户，确认后加 force:true。`,
                );
              }
              item.status = 'doing';
              claimItem(item, exec.agent);
            } else {
              item.status = args.status;
              releaseItem(item);
              if (args.status === 'done') {
                normalizeGoal(goal);
                autoAdvance(goal, exec.agent);
              }
            }
          }
          break;
        }
        case 'delete_item': {
          const item = itemRef(goal, args.item);
          if (!item) throw new Error(`没有找到条目：${args.item ?? '（未提供）'}`);
          if (!args.confirm) throw new Error('delete_item 需要 confirm:true（先问用户，确认后再删）');
          goal.items = goal.items.filter((i) => i.id !== item.id);
          // 删掉的可能是唯一在做的条目：让下一条接上，卡片才不会卡在「没人认领」。
          autoAdvance(goal, exec.agent);
          break;
        }
        case 'reorder_items': {
          if (!Array.isArray(args.order) || args.order.length === 0) throw new Error('reorder_items 需要 order（条目 id 数组）');
          const byId = new Map(goal.items.map((i) => [i.id, i]));
          const next = [];
          for (const id of args.order) {
            const item = byId.get(id);
            if (item) {
              next.push(item);
              byId.delete(id);
            }
          }
          for (const item of byId.values()) next.push(item);
          goal.items = next;
          break;
        }
        case 'update_goal': {
          if (args.title !== undefined) goal.title = args.title;
          if (args.doneWhen !== undefined) goal.doneWhen = args.doneWhen;
          break;
        }
        case 'complete_goal': {
          const pointer = String(args.pointer ?? '').trim();
          if (!pointer) throw new Error('complete_goal 必须填 pointer（产出指针：资产库路径 / commit / 文档链接）');
          archiveGoal(project, goal, pointer);
          // 归档后直接从清单移除（用户定：完成区只留未归档的）。
          project.goals = project.goals.filter((g) => g.id !== goal.id);
          break;
        }
        case 'suspend_goal': {
          goal.status = 'suspended';
          break;
        }
        case 'resume_goal': {
          goal.status = 'active';
          break;
        }
        case 'delete_goal': {
          if (!args.confirm) throw new Error('delete_goal 需要 confirm:true（先问用户，确认后再删）');
          tombstone(project, goal);
          project.goals = project.goals.filter((g) => g.id !== goal.id);
          break;
        }
        default:
          throw new Error(`未知 action：${action}`);
      }

      await save();
      return { text: renderFull(project) };
    },
  });
}

// ---------------------------------------------------------------- 面板 API

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体太大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function statePayload() {
  sweepStaleClaims();
  return {
    projects: data.projects.map((p) => ({
      id: p.id,
      name: p.name,
      folders: p.folders ?? [],
      goals: (p.goals ?? []).map((g) => ({
        id: g.id,
        title: g.title,
        doneWhen: g.doneWhen ?? '',
        status: g.status,
        completedAt: g.completedAt ?? null,
        pointer: g.pointer ?? null,
        // 哪些会话在这个目标上干过活（有 doing 条目 + owner 即算）。
        // 过期认领在上面 sweepStaleClaims() 里已经自动摘掉了，这里剩下的都是活的。
        sessions: [
          ...new Map(
            (g.items ?? [])
              .filter((i) => i.status === 'doing' && i.owner?.sessionId)
              .map((i) => [i.owner.sessionId, { ...i.owner, stale: isStaleOwner(i.owner) }]),
          ).values(),
        ],
        items: (g.items ?? []).map((i) => ({
          id: i.id,
          text: i.text,
          status: i.status,
          note: i.note ?? '',
          owner: i.owner ? { ...i.owner, stale: isStaleOwner(i.owner) } : null,
        })),
      })),
    })),
    archive: data.archive.slice(-50).reverse(),
    // 最近在跑、但可能没记账的会话：面板据此提醒"这个会话在干活却没卡"。
    sessions: recentSessions().map((r) => ({
      id: r.id,
      label: r.label ?? '',
      cwd: r.cwd ?? '',
      turns: r.turns ?? 0,
      hasCard: !!r.hasCard,
      // 文件夹还没归到任何项目的会话不算「忘了记账」——它还什么都没开始。
      inProject: !!(r.cwd && findProjectByCwd(r.cwd)),
      lastSeen: r.lastSeen ?? 0,
    })),
  };
}

// 四个面板动作共用同一套「找项目 / 找目标 / 回活跃态」，统一在这里，别各写一遍。
function needProject(body) {
  const project = projectRef(body.projectId);
  if (!project) throw new Error('项目不存在');
  return project;
}

function needGoal(project, body) {
  const goal = goalRef(project, body.goalId);
  if (!goal) throw new Error('目标不存在');
  return goal;
}

function resetToActive(goal) {
  goal.completedAt = null;
  goal.pointer = null;
}

function applyMove(body) {
  const project = needProject(body);
  const goal = needGoal(project, body);
  if (!GOAL_STATUSES.includes(body.toStatus)) throw new Error('目标状态不合法');
  const goals = project.goals;
  goals.splice(goals.indexOf(goal), 1);
  goal.status = body.toStatus;
  if (goal.status === 'active') resetToActive(goal);
  const sameStatus = goals.filter((g) => g.status === goal.status);
  const toIndex = Math.max(0, Math.min(Number(body.toIndex ?? sameStatus.length), sameStatus.length));
  const target = sameStatus[toIndex];
  if (target) goals.splice(goals.indexOf(target), 0, goal);
  else goals.push(goal);
}

function applyUpdate(body) {
  const project = needProject(body);
  const goal = needGoal(project, body);
  if (body.pointer !== undefined) {
    const pointer = String(body.pointer).trim();
    if (!pointer) throw new Error('完成目标必须填产出指针');
    goal.pointer = pointer;
    if (body.archive === true) {
      archiveGoal(project, goal, pointer);
      project.goals = project.goals.filter((g) => g.id !== goal.id);
    }
    return;
  }
  if (body.status !== undefined) {
    if (!GOAL_STATUSES.includes(body.status)) throw new Error('目标状态不合法');
    goal.status = body.status;
    if (goal.status === 'active') resetToActive(goal);
  }
}

function applyDelete(body) {
  const project = needProject(body);
  if (body.itemId) {
    const goal = needGoal(project, body);
    const before = goal.items.length;
    goal.items = goal.items.filter((i) => i.id !== body.itemId);
    if (goal.items.length === before) throw new Error('条目不存在');
    return;
  }
  if (body.goalId) {
    const goal = project.goals.find((g) => g.id === body.goalId);
    if (!goal) throw new Error('目标不存在');
    tombstone(project, goal);
    project.goals = project.goals.filter((g) => g.id !== body.goalId);
    return;
  }
  throw new Error('要删什么？给 goalId 或 itemId');
}

function applyRelease(body) {
  const project = needProject(body);
  const removed = releaseClaims(project, {
    sessionId: body.sessionId ? String(body.sessionId) : undefined,
    goalId: body.goalId ? String(body.goalId) : undefined,
    itemId: body.itemId ? String(body.itemId) : undefined,
  });
  if (!removed) throw new Error('没有可释放的认领');
  return removed;
}

const POST_ACTIONS = {
  '/move': applyMove,
  '/update': applyUpdate,
  '/delete': applyDelete,
  '/release': applyRelease,
};

function registerApi(ctx) {
  const webServer = ctx.get?.('webServer') ?? ctx.webServer;
  if (!webServer || typeof webServer.register !== 'function') return null;
  const origin = webServer.getOrigin?.() || '';

  const handle = async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (!url.pathname.startsWith(API_PREFIX + '/')) return json(res, 404, { error: 'not found' });
      // 令牌 + 自定义头两道闸：页面 HTML 里注入了令牌就用令牌；注入没生效时，
      // 只要有自定义头和同源 Origin 也放行（跨站脚本发自定义头会触发预检，被挡）。
      const originHeader = req.headers.origin;
      const sameOrigin = !originHeader || !origin || originHeader === origin;
      const tokenOk = req.headers['x-goal-board-token'] === API_TOKEN;
      const headerOk = req.headers['x-goal-board'] === '1';
      if (!(tokenOk || (headerOk && sameOrigin))) return json(res, 403, { error: '缺少面板令牌' });

      const action = url.pathname.slice(API_PREFIX.length);
      if (req.method === 'GET' && action === '/state') return json(res, 200, statePayload());
      const write = req.method === 'POST' ? POST_ACTIONS[action] : null;
      if (write) {
        write(await readBody(req));
        await save();
        return json(res, 200, statePayload());
      }
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      const message = String(e?.message ?? e).slice(0, 300);
      if (!res.headersSent) json(res, 400, { error: message });
      else res.end();
    }
  };

  return webServer.register({ kind: 'prefix', path: API_PREFIX, handler: handle });
}

// ---------------------------------------------------------------- 入口

async function loadDefineTool() {
  try {
    const mod = await import('@deepseek-ai/dsh-tools');
    if (typeof mod.defineTool === 'function') return mod.defineTool;
  } catch {
    /* 回退到恒等函数：工具定义本来就是普通对象 */
  }
  return (spec) => spec;
}

export async function apply(ctx) {
  const disposers = [];
  try {
    await load();
    const defineTool = await loadDefineTool();

    disposers.push(ctx.tools.register(readTool(defineTool)));
    disposers.push(ctx.tools.register(updateTool(defineTool)));

    disposers.push(
      ctx.systemPrompt.context({
        name: 'goal-board:current',
        order: 2500,
        required: false,
        interpolate: false,
        text: (context) => (context.agent === undefined ? '' : renderInjection(context.agent)),
      }),
    );

    // 会话关闭 = 认领立刻释放，不用等 TTL 过期。
    disposers.push(
      ctx.on('agent/disposed', ({ agent }) => {
        try {
          const me = sessionInfo(agent);
          if (!me.id) return;
          let removed = 0;
          for (const project of data.projects) {
            removed += releaseClaims(project, { sessionId: me.id });
          }
          if (removed > 0) save().catch(() => {});
        } catch {
          /* ignore */
        }
      }),
    );

    ctx.inject(['workingDirectory'], (c) => {
      wdGet = (session) => {
        try {
          return c.workingDirectory.get(session);
        } catch {
          return null;
        }
      };
    });

    ctx.inject(['webServer'], (c) => {
      const dispose = registerApi(c);
      if (dispose) disposers.push(dispose);
      disposers.push(
        c.on('webserver/index-inject', (table) => {
          table.push({ kind: 'global', name: INDEX_GLOBAL, value: { token: API_TOKEN } });
        }),
      );
    });
  } catch (e) {
    console.warn('[dsh-goal-board] 启动失败：' + String(e?.message ?? e));
  }

  return () => {
    for (const dispose of disposers) {
      try {
        dispose?.();
      } catch {
        /* ignore */
      }
    }
  };
}
