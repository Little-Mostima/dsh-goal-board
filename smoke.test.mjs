// 冒烟测试：假 ctx 跑一遍插件入口 + 工具 + 面板 API，验证改完还能加载、能自动释放认领。
// 用完即删，不留在插件目录里。
import { mkdtemp, rm, readFile } from 'node:fs/promises';
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
const state = await new Promise((resolve, reject) => {
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
const goal = state.projects[0].goals[0];
const item = goal.items[0];
ok('过期认领自动释放', item.owner === null && item.status === 'todo', `owner=${JSON.stringify(item.owner)} status=${item.status}`);
ok('目标回到排队（无会话）', goal.sessions.length === 0);

await new Promise((res) => setTimeout(res, 200));
const raw = JSON.parse(await readFile(path.join(home, 'goal-board', 'data.json'), 'utf8'));
ok('自动释放已落盘', raw.projects[0].goals[0].items[0].owner === null);

await rm(home, { recursive: true, force: true });
console.log(results.join('\n'));
process.exit(results.some((l) => l.startsWith('FAIL')) ? 1 : 0);
