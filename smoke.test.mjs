// 冒烟测试：假 ctx 跑一遍插件入口 + 工具 + 面板 API，验证改完还能加载、能自动释放认领。
// 用完即删，不留在插件目录里。
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import os from 'node:os';

const home = await mkdtemp(path.join(os.tmpdir(), 'dgb-smoke-'));
process.env.DSH_HOME = home;
process.env.DSH_GOAL_BOARD_TTL_MS = '600';

const mod = await import('file:///C:/Users/Mostima/.dsh/plugins/dsh-goal-board/index.js?' + Date.now());

const tools = {};
let promptCtx = null;
let apiHandler = null;
const agent = { session: { header: { id: 'sess-abcdef123456', cwd: 'D:\\smoke-ws' } } };

const ctx = {
  tools: {
    register(spec) {
      tools[spec.name] = spec;
      return () => {};
    },
  },
  systemPrompt: {
    context(c) {
      promptCtx = c;
      return () => {};
    },
  },
  on: () => () => {},
  get: (name) =>
    name === 'webServer'
      ? {
          getOrigin: () => 'http://127.0.0.1:12002',
          register({ handler }) {
            apiHandler = handler;
            return () => {};
          },
        }
      : undefined,
  inject: (deps, fn) => {
    if (deps.includes('workingDirectory')) fn({ workingDirectory: { get: () => 'D:\\smoke-ws' } });
    if (deps.includes('webServer')) {
      const service = {
        on: () => () => {},
        register({ handler }) {
          apiHandler = handler;
          return () => {};
        },
        getOrigin: () => 'http://127.0.0.1:12002',
      };
      fn(Object.assign(service, { get: (n) => (n === 'webServer' ? service : undefined) }));
    }
  },
};

const results = [];
const ok = (label, cond, extra = '') => results.push(`${cond ? 'PASS' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`);

await mod.apply(ctx);
ok('pluggable 工具注册', !!tools.goal_board_read && !!tools.goal_board_update);
ok('注入钩子注册', !!promptCtx);

const readState = () =>
  new Promise((resolve, reject) => {
    const req = { method: 'GET', url: '/goal-board/api/state', headers: { 'x-goal-board': '1' } };
    const res = {
      headersSent: false,
      statusCode: 0,
      setHeader() {},
      end(body) {
        resolve(JSON.parse(body));
      },
      writeHead() {},
    };
    apiHandler(req, res).catch(reject);
  });

const exec = { agent };
const upd = (args) => tools.goal_board_update.execute(args, exec);

let r = await upd({ action: 'add_goal', title: '冒烟目标', doneWhen: '能跑通就算过' });
ok('add_goal 按 cwd 自动建项目', /已新建目标/.test(r.text) && /smoke-ws/.test(r.text), r.text.split('\n')[0]);
r = await upd({ action: 'add_item', text: '第一条', goal: '冒烟目标' });
ok('add_item 自动认领', /doing|进行/.test(r.text));

const injection = promptCtx.text({ agent });
ok('每轮注入有清单', /【目标清单】/.test(injection) && /冒烟目标/.test(injection));
ok('注入含拆卡规则', /一张卡只放同一件事/.test(injection));

// 自动释放：认领后等 TTL 过期，面板读状态应该把条目退回 todo 并摘掉 owner。
await new Promise((res) => setTimeout(res, 900));
const state = await readState();
const goal = state.projects[0].goals[0];
const item = goal.items[0];
ok('过期认领自动释放', item.owner === null && item.status === 'todo', `owner=${JSON.stringify(item.owner)} status=${item.status}`);
ok('目标回到排队（无会话）', goal.sessions.length === 0);

await new Promise((res) => setTimeout(res, 200));
const raw = JSON.parse(await readFile(path.join(home, 'goal-board', 'data.json'), 'utf8'));
ok('自动释放已落盘', raw.projects[0].goals[0].items[0].owner === null);

// 会话登记：有卡的会话记为已记账；没卡的会话在注入里被点名，面板能看到。
ok('有卡的会话记为已记账', (state.sessions ?? []).some((s) => s.id === 'sess-abcdef123456' && s.hasCard === true));

const agent2 = { session: { header: { id: 'sess-second-999999', cwd: 'D:\\smoke-ws' } } };
const injection2 = promptCtx.text({ agent: agent2 });
ok('未记账会话被注入点名', /还没有任何记录/.test(injection2));
await new Promise((res) => setTimeout(res, 150));
const state2 = await readState();
const loose = (state2.sessions ?? []).find((s) => s.id === 'sess-second-999999');
ok('面板能看到未记账会话', !!loose && loose.hasCard === false && loose.turns >= 1, JSON.stringify(loose));

// 删掉正在做的那条，下一条要自动接上，卡片不能卡在「没人认领」。
r = await upd({ action: 'add_item', goal: '冒烟目标', text: '第二条' });
const del = await upd({ action: 'delete_item', goal: '冒烟目标', item: '第二条', confirm: true });
ok('删条目后下一条自动接手', /第一条/.test(del.text) && /doing/.test(del.text), del.text.split('\n').find((l) => l.includes('第一条')) || '');

// 面板的写接口：POST 分发、读 body、落盘、回全量状态，一条链路走通。
const post = (pathname, payload) =>
  new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method = 'POST';
    req.url = pathname;
    req.headers = { 'x-goal-board': '1' };
    const res = {
      headersSent: false,
      statusCode: 0,
      setHeader() {},
      writeHead(status) {
        this.statusCode = status;
      },
      end(body) {
        resolve({ status: this.statusCode, data: JSON.parse(body) });
      },
    };
    setTimeout(() => {
      req.emit('data', Buffer.from(JSON.stringify(payload)));
      req.emit('end');
    }, 0);
    apiHandler(req, res).catch(reject);
  });

const moved = await post('/goal-board/api/move', {
  projectId: state.projects[0].id,
  goalId: goal.id,
  toStatus: 'suspended',
});
ok(
  '面板写接口改状态并落盘',
  moved.status === 200 && moved.data.projects[0].goals[0].status === 'suspended',
  'status=' + moved.data.projects[0].goals[0].status,
);

// 手动删掉的卡要留墓碑：注入里点名「不要重建」，墓碑文件也落盘。
await upd({ action: 'delete_goal', goal: '冒烟目标', confirm: true });
const injection3 = promptCtx.text({ agent });
const tombRaw = JSON.parse(await readFile(path.join(home, 'goal-board', 'tombstones.json'), 'utf8'));
ok(
  '删目标留墓碑并注入',
  /已删除的目标/.test(injection3) && /冒烟目标/.test(injection3) && tombRaw.some((t) => t.title === '冒烟目标'),
  injection3.split('\n')[0],
);

await rm(home, { recursive: true, force: true });
console.log(results.join('\n'));
process.exit(results.some((l) => l.startsWith('FAIL')) ? 1 : 0);
