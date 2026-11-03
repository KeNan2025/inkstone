/**
 * 砚台 · Inkstone — the CSTCloud Overleaf workbench.
 *
 * Draft locally, publish from the cloud.
 *
 * The panel drives one loop: pick a LaTeX folder, sync it to latex.cstcloud.cn,
 * compile there without any local TeX, and show the diagnostics so the agent can
 * fix the sources and sync again.
 *
 * Presentation: an inkstone on paper. Quiet typography, an ink wash behind the
 * hero, a single dominant action. The Host owns every network call and all
 * filesystem access; this half only renders and posts JSON to the same-origin
 * /api/dsh-overleaf route family.
 *
 * Route paths are DOCUMENT-RELATIVE on purpose (no leading slash): the harness
 * serves the GUI with `<base href="./">`, so a sub-path deployment keeps working.
 *
 * Every colour comes from a `--dsw-alias-*` theme token, and each text-bearing
 * surface declares the foreground token that pairs with its background, so light
 * and dark are both legible.
 */

window.__ModuleLoader__.load({
  id: 'dsh-inkstone',
  factory(require) {
    const React = require('react');
    const E = React.createElement;

    const PANEL_ID = 'inkstone';
    const PANEL_ORDER = 40;

    const API = {
      status: 'api/dsh-overleaf/status',
      workspace: 'api/dsh-overleaf/workspace',
      saveSession: 'api/dsh-overleaf/credential',
      clearSession: 'api/dsh-overleaf/credential/clear',
      recheck: 'api/dsh-overleaf/login',
      projects: 'api/dsh-overleaf/projects',
      link: 'api/dsh-overleaf/link',
      sync: 'api/dsh-overleaf/sync',
      diagnostics: 'api/dsh-overleaf/diagnostics',
    };

    // ---------------------------------------------------------------- styles
    // Paper first, ink on it. Two surfaces only: the page and a raised card.
    // Decorative ink washes use the brand token at low alpha so they never carry
    // information and never need their own contrast budget.
    const CSS = `
.is-root{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;overflow:hidden}
.is-root::before{content:"";position:absolute;inset:0;pointer-events:none;
  background:radial-gradient(60% 40% at 12% 0%, var(--dsw-alias-brand-primary) 0%, transparent 62%);
  opacity:.08}
.is-root::after{content:"";position:absolute;right:-6%;bottom:-14%;width:46%;height:42%;pointer-events:none;
  background:radial-gradient(closest-side, var(--dsw-alias-brand-primary) 0%, transparent 70%);
  opacity:.05}
.is-head{position:relative;z-index:1;display:flex;align-items:center;gap:10px;padding:14px 22px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto}
.is-mark{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:9px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-brand-primary)}
.is-title{font-size:16px;font-weight:650;letter-spacing:.04em;color:var(--dsw-alias-label-primary)}
.is-sub{color:var(--dsw-alias-label-secondary);font-size:11.5px;letter-spacing:.08em;text-transform:uppercase}
.is-grow{flex:1 1 auto}
.is-chip{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:2px 10px;font-size:11px;font-weight:600;line-height:18px;border:1px solid transparent;white-space:nowrap}
.is-chip-dot{width:5px;height:5px;border-radius:50%;background:currentColor}
.is-chip-ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.is-chip-bad{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.is-chip-idle{color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l2)}
.is-chip-warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.is-body{position:relative;z-index:1;flex:1 1 auto;min-height:0;overflow:auto;padding:22px 22px 34px;display:flex;flex-direction:column;gap:16px;scrollbar-width:thin}
.is-hero{display:flex;flex-direction:column;gap:8px;padding:6px 2px 14px}
.is-hero-title{font-size:22px;font-weight:650;line-height:1.25;letter-spacing:.01em;color:var(--dsw-alias-label-primary)}
.is-hero-title .is-accent{color:var(--dsw-alias-brand-primary)}
.is-hero-sub{color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:1.7;max-width:56ch}
.is-rule{height:1px;background:var(--dsw-alias-border-l1);width:64px;margin-top:6px}
.is-card{position:relative;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:14px;padding:16px 18px;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary);}
.is-card-accent{border-color:var(--dsw-alias-brand-primary)}
.is-card-h{display:flex;align-items:center;gap:10px;font-weight:600;font-size:13px;color:var(--dsw-alias-label-primary)}
.is-num{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-brand-primary);font-size:11px;font-weight:700}
.is-label{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;letter-spacing:.06em;text-transform:uppercase}
.is-field{display:flex;flex-direction:column;gap:6px}
.is-input,.is-select{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:9px;padding:9px 12px;font-size:13px;font-family:inherit;outline:none;min-width:0;transition:border-color .15s ease}
.is-input::placeholder,.is-area::placeholder{color:var(--dsw-alias-label-secondary);opacity:1}
.is-input:focus,.is-select:focus,.is-area:focus{border-color:var(--dsw-alias-brand-primary)}
.is-input-dir{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12.5px}
.is-row{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap}
.is-row > .is-field{flex:1 1 240px}
.is-row > .is-field-sm{flex:0 1 200px}
.is-area{width:100%;min-height:60px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:1.55;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:9px;padding:10px 12px;outline:none}
.is-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:9px;padding:9px 16px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit;white-space:nowrap;transition:border-color .15s ease,color .15s ease}
.is-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.is-btn:disabled{opacity:.5;cursor:not-allowed}
.is-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font-weight:700;padding:11px 22px;font-size:13px;letter-spacing:.04em}
.is-btn-primary:hover:not(:disabled){color:var(--dsw-alias-bg-base);filter:brightness(1.08)}
.is-btn-quiet{background:none;border-color:transparent;color:var(--dsw-alias-label-secondary);padding:7px 10px}
.is-btn-quiet:hover:not(:disabled){color:var(--dsw-alias-brand-primary);border-color:transparent}
.is-btn-danger:hover:not(:disabled){border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.is-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px;word-break:break-all;color:var(--dsw-alias-label-primary)}
.is-hint{font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.75}
.is-hint strong{color:var(--dsw-alias-label-primary);font-weight:600}
.is-link{color:var(--dsw-alias-brand-primary);cursor:pointer;text-decoration:underline;background:none;border:none;padding:0;font:inherit}
.is-notice{border-radius:10px;padding:10px 14px;font-size:12px;line-height:1.7;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.is-notice-err{border-color:var(--dsw-alias-state-error-primary)}
.is-notice-warn{border-color:var(--dsw-alias-state-warn-primary)}
.is-steps{display:flex;flex-direction:column;gap:5px;margin:0;padding-left:18px;font-size:12px;line-height:1.75;color:var(--dsw-alias-label-primary)}
.is-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.is-meta{display:flex;gap:14px;flex-wrap:wrap;align-items:center}
.is-meta-item{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:11.5px}
.is-meta-item strong{color:var(--dsw-alias-label-primary);font-weight:600}
.is-divider{height:1px;background:var(--dsw-alias-border-l1);flex:0 0 auto}
.is-log{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;max-height:280px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-primary)}
.is-diag{display:flex;flex-direction:column;gap:8px}
.is-diag-row{border-left:3px solid var(--dsw-alias-border-l2);padding:6px 0 6px 12px;font-size:12px;line-height:1.65}
.is-diag-err{border-left-color:var(--dsw-alias-state-error-primary)}
.is-diag-warn{border-left-color:var(--dsw-alias-state-warn-primary)}
.is-diag-kind{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}
.is-diag-text{color:var(--dsw-alias-label-primary);word-break:break-word}
.is-diag-ctx{color:var(--dsw-alias-label-secondary);font-family:ui-monospace,Consolas,monospace;font-size:11px}
.is-empty{color:var(--dsw-alias-label-secondary);font-size:12.5px;padding:4px 0}
.is-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:14px 22px;border-top:1px solid var(--dsw-alias-border-l1);flex:0 0 auto}
.is-foot .is-hint{margin:0}
.is-progress{display:flex;align-items:center;gap:8px}
.is-progress-step{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:11.5px}
.is-progress-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-border-l2)}
.is-progress-on .is-progress-dot{background:var(--dsw-alias-brand-primary)}
.is-progress-done .is-progress-dot{background:var(--dsw-alias-state-success-primary)}
.is-progress-err .is-progress-dot{background:var(--dsw-alias-state-error-primary)}
.is-progress-on{color:var(--dsw-alias-brand-primary)}
.is-progress-done{color:var(--dsw-alias-state-success-primary)}
.is-progress-err{color:var(--dsw-alias-state-error-primary)}
.is-breathe{animation:is-breathe 1.6s ease-in-out infinite}
@keyframes is-breathe{0%,100%{opacity:.55}50%{opacity:1}}
.is-inkline{height:2px;background:linear-gradient(90deg,var(--dsw-alias-brand-primary),transparent);border-radius:2px;flex:0 0 auto}
`;

    // ------------------------------------------------------------ primitives
    function Chip(props) {
      return E(
        'span',
        { className: 'is-chip is-chip-' + (props.tone || 'idle') },
        E('span', { className: 'is-chip-dot' }),
        props.children
      );
    }

    function Notice(props) {
      return E(
        'div',
        { className: 'is-notice' + (props.tone ? ' is-notice-' + props.tone : '') },
        props.children
      );
    }

    async function call(path, options) {
      const opts = options || {};
      const headers = new Headers();
      if (opts.body !== undefined) headers.set('content-type', 'application/json');
      const response = await fetch(path, {
        method: opts.method || (opts.body === undefined ? 'GET' : 'POST'),
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        credentials: 'same-origin',
      });
      const text = await response.text();
      let body;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch (err) {
          body = { error: text.slice(0, 400) };
        }
      }
      if (!response.ok) {
        const error = new Error((body && typeof body.error === 'string' && body.error) || 'HTTP ' + response.status);
        error.status = response.status;
        error.body = body;
        throw error;
      }
      return body || {};
    }

    /** The inkstone mark, also used as the sidebar glyph. */
    function InkstoneIcon(props) {
      const size = props && props.size ? props.size : 18;
      return E(
        'svg',
        {
          'data-dsh-panel-entry': PANEL_ID,
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        E('path', { d: 'M3.2 13.4c0-2.6 4.0-4.6 9.0-4.6s9.0 2.0 9.0 4.6-4.0 4.6-9.0 4.6-9.0-2.0-9.0-4.6z', key: 'a' }),
        E('path', { d: 'M7.0 13.6c0-1.3 2.3-2.3 5.2-2.3s5.2 1.0 5.2 2.3-2.3 2.3-5.2 2.3-5.2-1.0-5.2-2.3z', key: 'b' }),
        E('path', { d: 'M16.6 5.2l-1.7 6.2M16.6 5.2l.9 1.1-.5 2.0', key: 'c' })
      );
    }

    /** An ink-stroke divider used between sections. */
    function InkLine() {
      return E('div', { className: 'is-inkline' });
    }

    // ----------------------------------------------------------------- page
    function WorkbenchPage() {
      const [state, setState] = React.useState({
        loading: true,
        error: null,
        status: null,
        cookie: '',
        showConnect: false,
        dir: '',
        busy: null,
        result: null,
        link: null,
        lastCompile: null,
      });
      const stateRef = React.useRef(state);
      stateRef.current = state;

      const set = React.useCallback((patch) => {
        setState((prev) => Object.assign({}, prev, typeof patch === 'function' ? patch(prev) : patch));
      }, []);

      const applyStatus = React.useCallback((status) => {
        setState((prev) => {
          const next = Object.assign({}, prev, { status, loading: false });
          const ws = status && status.workspace;
          if (ws && !prev.dir) next.dir = ws.dir || '';
          if (!next.dir && status && Array.isArray(status.workspaces) && status.workspaces[0]) {
            next.dir = status.workspaces[0].path;
          }
          return next;
        });
      }, []);

      React.useEffect(() => {
        let alive = true;
        (async () => {
          try {
            const res = await call(API.status);
            if (alive) applyStatus(res);
          } catch (err) {
            if (alive) set({ error: err.message, loading: false });
          }
        })();
        return () => {
          alive = false;
        };
      }, [applyStatus, set]);

      // Persist the folder choice and read the link + last compile for it.
      React.useEffect(() => {
        if (state.loading || !state.dir) return undefined;
        let alive = true;
        const timer = setTimeout(async () => {
          try {
            const res = await call(API.workspace + '?dir=' + encodeURIComponent(stateRef.current.dir));
            if (!alive || !res.workspace) return;
            set({ workspace: res.workspace });
            const diag = await call(API.diagnostics + '?dir=' + encodeURIComponent(stateRef.current.dir));
            if (!alive) return;
            set({ link: diag.link || null, lastCompile: diag.lastCompile || null });
          } catch (err) {
            /* a missing folder simply means no link yet */
          }
        }, 500);
        return () => {
          alive = false;
          clearTimeout(timer);
        };
      }, [state.dir, state.loading, set]);

      const saveSession = React.useCallback(async () => {
        const raw = (stateRef.current.cookie || '').trim();
        if (!raw) {
          set({ error: '请先粘贴 Overleaf 的会话 Cookie。' });
          return;
        }
        set({ busy: 'session', error: null });
        try {
          const res = await call(API.saveSession, { body: { cookie: raw } });
          set({ cookie: '', showConnect: false });
          if (res && res.status) applyStatus(res.status);
          else applyStatus(await call(API.status));
        } catch (err) {
          set({ error: err.message });
        } finally {
          set({ busy: null });
        }
      }, [applyStatus, set]);

      const clearSession = React.useCallback(async () => {
        set({ busy: 'session', error: null });
        try {
          const res = await call(API.clearSession, { body: {} });
          if (res && res.status) applyStatus(res.status);
        } catch (err) {
          set({ error: err.message });
        } finally {
          set({ busy: null });
        }
      }, [applyStatus, set]);

      const recheck = React.useCallback(async () => {
        set({ busy: 'check', error: null });
        try {
          const res = await call(API.recheck, { body: {} });
          applyStatus((res && res.status) || (await call(API.status)));
          if (res && res.session && res.session.loggedIn === false && res.session.message) {
            set({ error: res.session.message });
          }
        } catch (err) {
          set({ error: err.message });
        } finally {
          set({ busy: null });
        }
      }, [applyStatus, set]);

      const pickDirectory = React.useCallback(async () => {
        set({ busy: 'pick', error: null });
        try {
          const res = await call('api/dsh-overleaf/choose-directory', { body: {} });
          if (res && res.dir) set({ dir: res.dir });
        } catch (err) {
          set({ error: err.message });
        } finally {
          set({ busy: null });
        }
      }, [set]);

      /** Push local sources, compile remotely, show the diagnostics. */
      const runSync = React.useCallback(async () => {
        const cur = stateRef.current;
        if (!cur.dir) {
          set({ error: '请先选择项目文件夹。' });
          return;
        }
        set({ busy: 'sync', error: null, result: null });
        try {
          // rootFile/compiler are left to the Host: it auto-detects and persists
          // the engine, so the panel no longer shows either control.
          const res = await call(API.sync, { body: { dir: cur.dir } });
          set({
            result: res,
            link: res.link || cur.link,
            lastCompile: res.summary
              ? {
                  status: res.status,
                  summary: res.summary,
                  seconds: res.seconds,
                  at: res.at,
                  projectId: res.projectId,
                }
              : cur.lastCompile,
          });
        } catch (err) {
          set({ error: err.message });
        } finally {
          set({ busy: null });
        }
      }, [set]);

      const openRemote = React.useCallback(() => {
        const url = stateRef.current.result && stateRef.current.result.remoteUrl;
        if (!url) return;
        try {
          const a = document.createElement('a');
          a.href = url;
          a.target = '_blank';
          a.rel = 'noopener';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        } catch (err) {
          window.open(url, '_blank', 'noopener');
        }
      }, []);

      const copyLog = React.useCallback(() => {
        const r = stateRef.current.result;
        const text = (r && (r.log || r.rawLog)) || '';
        if (!text) return;
        try {
          navigator.clipboard.writeText(text);
        } catch (err) {
          /* clipboard may be unavailable */
        }
      }, []);

      const status = state.status || {};
      const auth = status.auth || {};
      const workspaces = Array.isArray(status.workspaces) ? status.workspaces : [];
      const ws = status.workspace || state.workspace || {};
      const busy = !!state.busy;
      const result = state.result;
      const showConnectCard = state.showConnect || !auth.configured;
      const lastCompile = state.lastCompile;

      return E(
        'div',
        { className: 'is-root', 'data-dsh-plugin': 'inkstone' },

        // ---- header
        E(
          'div',
          { className: 'is-head' },
          E('span', { className: 'is-mark' }, E(InkstoneIcon, { size: 17 })),
          E('span', { className: 'is-title' }, '砚台'),
          E('span', { className: 'is-sub' }, 'Inkstone · CSTCloud'),
          E('span', { className: 'is-grow' }),
          auth.loggedIn
            ? Chip({ tone: 'ok', children: auth.email || '已连接' })
            : auth.configured
            ? Chip({ tone: 'warn', children: '会话已失效' })
            : Chip({ tone: 'idle', children: '未连接' }),
          E('button', { className: 'is-btn is-btn-quiet', onClick: recheck, disabled: busy },
            state.busy === 'check' ? '检查中…' : '检查连接')
        ),

        // ---- body
        E(
          'div',
          { className: 'is-body' },

          // hero
          E(
            'div',
            { className: 'is-hero' },
            E(
              'div',
              { className: 'is-hero-title' },
              E('span', {}, '本地起笔，'),
              E('span', { className: 'is-accent' }, '云端成书')
            ),
            E(
              'div',
              { className: 'is-hero-sub' },
              '把论文素材研入云端：选定本地 LaTeX 项目，同步到 latex.cstcloud.cn 并在服务器编译。无需本地 TeX，错误会被研回此地。'
            ),
            E('div', { className: 'is-rule' })
          ),

          state.error ? Notice({ tone: 'err', children: state.error }) : null,

          // connection
          showConnectCard
            ? E(
                'div',
                { className: 'is-card' },
                E(
                  'div',
                  { className: 'is-card-h' },
                  E('span', { className: 'is-num' }, '1'),
                  '接入云端'
                ),
                E(
                  'div',
                  { className: 'is-hint' },
                  '该站点用 ',
                  E('strong', {}, 'CSTCloud 统一身份认证'),
                  ' 登录，账号属 SSO 托管组，',
                  E('strong', {}, '没有本地密码'),
                  '。这里复用浏览器的登录态，',
                  E('strong', {}, '约 5 天有效'),
                  '。'
                ),
                E(
                  'olw-steps',
                  {},
                  E('span', {}, '浏览器打开 ', E('a', { className: 'is-link', href: 'https://latex.cstcloud.cn/project', target: '_blank', rel: 'noopener' }, 'latex.cstcloud.cn'), ' 并确认已登录'),
                  E('span', {}, '按 ', E('strong', {}, 'F12'), ' → ', E('strong', {}, 'Application'), ' → ', E('strong', {}, 'Cookies'), ' → ', E('strong', {}, 'https://latex.cstcloud.cn')),
                  E('span', {}, '找到 ', E('strong', {}, 'overleaf.sid'), '，双击 Value 全选复制'),
                  E('span', {}, '粘贴到下面，点「保存并验证」')
                ),
                E('textarea', {
                  className: 'is-area',
                  spellCheck: false,
                  placeholder: '粘贴 overleaf.sid 的值（也可粘贴整行 overleaf.sid=…）',
                  value: state.cookie,
                  onChange: (e) => set({ cookie: e.target.value }),
                }),
                E(
                  'div',
                  { className: 'is-actions' },
                  E(
                    'button',
                    { className: 'is-btn is-btn-primary', onClick: saveSession, disabled: busy },
                    state.busy === 'session' ? '正在验证…' : '保存并验证'
                  ),
                  auth.configured
                    ? E('button', { className: 'is-btn is-btn-danger', onClick: clearSession, disabled: busy }, '清除本地 Cookie')
                    : null,
                  E('span', { className: 'is-hint' }, 'Cookie 只保存在本机 DSH 进程，不回传浏览器、不写入对话记录。')
                )
              )
            : null,

          // folder
          E(
            'div',
            { className: 'is-card' },
            E(
              'div',
              { className: 'is-card-h' },
              E('span', { className: 'is-num' }, '2'),
              '选材'
            ),
            E('div', { className: 'is-hint' }, '选定要研的 LaTeX 项目文件夹。'),
            E(
              'div',
              { className: 'is-row' },
              E(
                'div',
                { className: 'is-field' },
                E('span', { className: 'is-label' }, '项目文件夹'),
                E('input', {
                  className: 'is-input is-input-dir',
                  type: 'text',
                  spellCheck: false,
                  placeholder: '例如 D:\\Paper\\thesis',
                  value: state.dir,
                  onChange: (e) => set({ dir: e.target.value }),
                })
              ),
              E('button', { className: 'is-btn', onClick: pickDirectory, disabled: busy },
                state.busy === 'pick' ? '选择中…' : '浏览…')
            ),
            workspaces.length
              ? E(
                  'div',
                  { className: 'is-field' },
                  E('span', { className: 'is-label' }, '或从已打开的工作区选取'),
                  E(
                    'select',
                    {
                      className: 'is-select',
                      value: '',
                      onChange: (e) => { if (e.target.value) set({ dir: e.target.value }); },
                    },
                    E('option', { value: '' }, '选择工作区…'),
                    workspaces.map((w) => E('option', { key: w.path, value: w.path }, w.name))
                  )
                )
              : null,
            ws.dir
              ? E(
                  'div',
                  { className: 'is-meta' },
                  E('span', { className: 'is-meta-item' }, E('strong', {}, String(ws.files || 0)), ' 个文件'),
                  E('span', { className: 'is-meta-item' }, E('strong', {}, ((ws.bytes || 0) / 1048576).toFixed(1)), ' MiB'),
                  ws.suggestedRoot
                    ? E('span', { className: 'is-meta-item' }, '主文件 ', E('span', { className: 'is-mono' }, ws.suggestedRoot))
                    : null
                )
              : null
          ),

          // sync action
          E(
            'div',
            { className: 'is-card is-card-accent' },
            E(
              'div',
              { className: 'is-card-h' },
              E('span', { className: 'is-num' }, '3'),
              '研墨成书'
            ),
            E('div', { className: 'is-hint' },
              '源码上传到你的 Overleaf 项目并在服务器编译，',
              E('strong', {}, '本地无需 TeX'),
              '。同名的旧项目会被替换，不会重复堆积。'
            ),
            E(
              'div',
              { className: 'is-actions' },
              E(
                'button',
                { className: 'is-btn is-btn-primary', onClick: runSync, disabled: busy || !state.dir },
                state.busy === 'sync' ? '研墨中…' : '同步并编译'
              ),
              E('span', { className: 'is-hint' }, '上传 + 编译约需一分钟。')
            ),
            lastCompile
              ? E(
                  'div',
                  { className: 'is-hint' },
                  '上次编译：',
                  lastCompile.status === 'success' ? '成功' : '失败',
                  lastCompile.seconds ? ' · ' + lastCompile.seconds + 's' : '',
                  state.link && state.link.name ? ' · 远端项目 ' + state.link.name : ''
                )
              : null
          ),

          // result
          result
            ? E(
                'div',
                { className: 'is-card' },
                E(
                  'div',
                  { className: 'is-card-h' },
                  '编译结果',
                  E('span', { className: 'is-grow' }),
                  result.status === 'success'
                    ? Chip({ tone: 'ok', children: '编译成功' })
                    : Chip({ tone: 'bad', children: '编译失败' }),
                  result.summary
                    ? E('span', { className: 'is-hint' },
                        result.summary.errors + ' 错误 · ' + result.summary.warnings + ' 警告')
                    : null
                ),
                E(
                  'div',
                  { className: 'is-meta' },
                  E('span', { className: 'is-meta-item' }, '远端项目 ', E('span', { className: 'is-mono' }, result.projectName)),
                  E('span', { className: 'is-meta-item' }, E('strong', {}, String(result.fileCount)), ' 个文件'),
                  E('span', { className: 'is-meta-item' }, E('strong', {}, String(result.seconds)), 's'),
                  E('span', { className: 'is-meta-item' }, result.status === 'success' ? '远端已更新' : '修正后再次同步')
                ),
                E(
                  'div',
                  { className: 'is-actions' },
                  E('button', { className: 'is-btn', onClick: openRemote }, '在 Overleaf 打开'),
                  result.log ? E('button', { className: 'is-btn', onClick: copyLog }, '复制编译日志') : null
                ),
                Array.isArray(result.diagnostics) && result.diagnostics.length
                  ? E(
                      'div',
                      { className: 'is-diag' },
                      result.diagnostics.slice(0, 25).map((d, i) =>
                        E(
                          'div',
                          {
                            key: i,
                            className:
                              'is-diag-row ' +
                              (d.kind === 'error' || d.kind === 'missing-file' ? 'is-diag-err' : 'is-diag-warn'),
                          },
                          E('div', { className: 'is-diag-kind' }, d.kind),
                          E('div', { className: 'is-diag-text' }, d.text),
                          d.context ? E('div', { className: 'is-diag-ctx' }, d.context) : null
                        )
                      )
                    )
                  : E('div', { className: 'is-empty' }, '没有捕获到错误或警告。'),
                result.log
                  ? E('details', {},
                      E('summary', { className: 'is-hint', style: { cursor: 'pointer' } }, '完整日志摘录'),
                      E('div', { className: 'is-log' }, result.log))
                  : null,
                Array.isArray(result.steps)
                  ? E(
                      'div',
                      { className: 'is-hint' },
                      result.steps.map((s, i) =>
                        E('div', { key: i }, (s.ok ? '✓ ' : '✗ ') + s.step + '：' + s.detail)
                      )
                    )
                  : null
              )
            : null,

          // quiet footnote
          E('div', { className: 'is-hint' },
            '砚台不替人执笔，只把素材研成可用的样子：',
            '本地编辑 → 同步 → 编译 → 报错回传 → 智能体修改。'
          )
        )
      );
    }

    // ------------------------------------------------------------- register
    function apply(ctx) {
      const slots = ctx.slots || (ctx.get ? ctx.get('slots') : undefined);
      if (!slots) return;

      // Retire the old panel id. The previous build registered
      // `overleaf-workbench`, and its client module may still be cached in the
      // boot graph, so the sidebar shows both entries at the same order.
      try {
        const entries = typeof slots.entries === 'function' ? slots.entries('sidebar.panellist') : null;
        if (Array.isArray(entries)) {
          for (const entry of entries) {
            if (entry && entry.options && entry.options.id === 'overleaf-workbench') {
              try {
                if (typeof entry.dispose === 'function') entry.dispose();
                else if (typeof entry.remove === 'function') entry.remove();
              } catch (err) {
                /* the slot owner drops it on the next boot */
              }
            }
          }
        }
      } catch (err) {
        console.warn('[inkstone] old panel retirement failed:', err);
      }


      ctx.effect(() => {
        if (typeof document === 'undefined') return () => {};
        if (document.querySelector('style[data-plugin-css="dsh-inkstone"]')) return () => {};
        const tag = document.createElement('style');
        tag.setAttribute('data-plugin-css', 'dsh-inkstone');
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return () => {
          if (tag.parentNode) tag.parentNode.removeChild(tag);
        };
      }, 'inkstone: styles');

      ctx.effect(
        () => {
          const disposers = [];
          try {
            disposers.push(
              slots.inject('sidebar.panellist', () =>
                slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: PANEL_ORDER }, InkstoneIcon)
              )
            );
            disposers.push(
              slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, WorkbenchPage))
            );
          } catch (err) {
            console.warn('[inkstone] panel registration failed:', err);
          }
          return () => {
            for (const dispose of disposers.splice(0)) {
              try {
                dispose();
              } catch (err) {
                /* ignore */
              }
            }
          };
        },
        'inkstone: panel'
      );
    }

    return { apply: apply, inject: ['slots'] };
  },
});
