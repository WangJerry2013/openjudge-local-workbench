/* 声屿主题控制器：状态只保存在浏览器 localStorage，所有页面共享。 */
(()=>{
  const key='openjudge-sound-isle-theme-v1';
  const defaults={mode:'light',brand:'#3d5bd1',accent:'#d8893f',page:'#f4f7fb',surface:'#ffffff',text:'#1e293b',radius:14,shadow:12,font:'Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',scale:1,contentScale:1,control:40,motion:180,density:'comfortable',avatar:''};
  const root=document.documentElement;
  const safeRead=()=>{try{return {...defaults,...JSON.parse(localStorage.getItem(key)||'{}')}}catch(_){return {...defaults}}};
  let state=safeRead();
  const cssName={brand:'--tj-brand',accent:'--tj-accent',page:'--tj-page',surface:'--tj-surface',text:'--tj-text'};
  const set=(patch={},persist=true)=>{
    state={...state,...patch};
    root.dataset.tjMode=state.mode==='dark'?'dark':'light';
    root.dataset.tjDensity=state.density==='compact'?'compact':'comfortable';
    Object.entries(cssName).forEach(([name,variable])=>{const useDarkDefault=state.mode==='dark'&&['page','surface','text'].includes(name)&&state[name]===defaults[name];if(useDarkDefault)root.style.removeProperty(variable);else root.style.setProperty(variable,state[name])});
    root.style.setProperty('--tj-radius',Math.max(4,Math.min(28,Number(state.radius)||14))+'px');
    root.style.setProperty('--tj-shadow',`0 18px ${Math.round(20+(Number(state.shadow)||0)*2)}px rgba(40,56,86,${Math.min(.26,.04+(Number(state.shadow)||0)/100).toFixed(2)})`);
    root.style.setProperty('--tj-shadow-soft',`0 3px ${Math.round(6+(Number(state.shadow)||0))}px rgba(40,56,86,${Math.min(.16,.025+(Number(state.shadow)||0)/160).toFixed(2)})`);
    root.style.setProperty('--tj-font',state.font);
    root.style.setProperty('--tj-scale',Math.max(.88,Math.min(1.2,Number(state.scale)||1)));
    root.style.setProperty('--tj-content-scale',Math.max(.88,Math.min(1.2,Number(state.contentScale)||1)));
    root.style.setProperty('--tj-control',Math.max(32,Math.min(52,Number(state.control)||40))+'px');
    const motion=Math.max(0,Math.min(420,Number(state.motion)||0));
    root.style.setProperty('--tj-motion',motion+'ms');root.style.setProperty('--tj-motion-slow',Math.max(1,Math.round(motion*1.55))+'ms');
    const avatar=String(state.avatar||'').trim();let avatarUrl='';try{const parsed=new URL(avatar,location.href);if(/^https?:$/.test(parsed.protocol)||/^data:image\//.test(avatar))avatarUrl=parsed.href}catch(_){}
    document.querySelectorAll('.account-menu>summary,.theme-user-menu>summary').forEach(summary=>{summary.classList.toggle('tj-avatar-image',Boolean(avatarUrl));summary.style.backgroundImage=avatarUrl?`url("${avatarUrl.replace(/"/g,'%22')}")`:''});
    if(persist){try{localStorage.setItem(key,JSON.stringify(state))}catch(_){}}
    window.dispatchEvent(new CustomEvent('openjudge-theme-change',{detail:state}));
    refreshFields();
  };
  const icon=(name)=>name==='settings'?'⚙':name==='close'?'×':'';
  const initials=value=>String(value||'访').trim().slice(0,2).toUpperCase()||'访';
  const setAvatar=summary=>{if(!summary)return;const label=(summary.textContent||summary.getAttribute('aria-label')||'访').replace(/[›⌄]/g,'').trim();summary.dataset.tjInitials=initials(label);summary.setAttribute('aria-label',label||'账号')};
  const drawer=()=>{
    if(document.getElementById('themeDrawer'))return;
    const shell=document.createElement('div');shell.innerHTML=`
      <div id="themeDrawerBackdrop" class="theme-drawer-backdrop"></div>
      <aside id="themeDrawer" class="theme-drawer" aria-label="设置" aria-hidden="true">
        <header><h2>设置</h2><button type="button" class="theme-drawer-close" aria-label="关闭设置">${icon('close')}</button></header>
        <nav class="theme-drawer-tabs" aria-label="设置分区"><button type="button" class="is-active" data-theme-tab="theme">主题设置</button><button type="button" data-theme-tab="display">页面显示</button></nav>
        <section class="theme-pane" data-theme-pane="theme">
          <div class="theme-group"><h3>颜色</h3>
            <label class="theme-field">文字颜色<input type="color" data-theme="text"></label>
            <label class="theme-field">页面背景<input type="color" data-theme="page"></label>
            <label class="theme-field">卡片背景<input type="color" data-theme="surface"></label>
            <label class="theme-field">强调色<input type="color" data-theme="brand"></label>
            <label class="theme-field">辅助色<input type="color" data-theme="accent"></label>
          </div>
          <div class="theme-group"><h3>外观</h3>
            <label class="theme-field">主题模式<select data-theme="mode"><option value="light">浅色</option><option value="dark">深色</option></select></label>
            <label class="theme-field">圆角大小<input type="range" min="4" max="28" step="1" data-theme="radius"><output></output></label>
            <label class="theme-field">阴影强度<input type="range" min="0" max="28" step="1" data-theme="shadow"><output></output></label>
            <label class="theme-field">字体<select data-theme="font"><option value='Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif'>系统无衬线</option><option value='ui-rounded, "SF Pro Rounded", "PingFang SC", system-ui, sans-serif'>圆润字体</option><option value='"Songti SC","Source Han Serif SC",Georgia,serif'>衬线字体</option></select></label>
            <button type="button" class="theme-reset" data-theme-deepseek>翻译设置</button>
          </div>
        </section>
        <section class="theme-pane" data-theme-pane="display" hidden>
          <div class="theme-group"><h3>页面显示</h3>
            <label class="theme-field">组件尺寸<input type="range" min="32" max="52" step="2" data-theme="control"><output></output></label>
            <label class="theme-field">页面文字<input type="range" min=".88" max="1.2" step=".02" data-theme="contentScale"><output></output></label>
            <label class="theme-field">界面密度<select data-theme="density"><option value="comfortable">舒适</option><option value="compact">紧凑</option></select></label>
            <label class="theme-field">动画速度<input type="range" min="0" max="420" step="20" data-theme="motion"><output></output></label>
            <label class="theme-field">头像图片<input type="url" data-theme="avatar" placeholder="留空使用文字头像"></label>
          </div>
          <div class="theme-group"><h3>同步说明</h3><p>设置保存在此浏览器，会立即应用到刷题台的所有页面与已打开标签页。</p></div>
        </section>
        <button type="button" class="theme-reset">恢复默认</button>
      </aside>`;
    document.body.append(...shell.children);
    const panel=document.getElementById('themeDrawer'),backdrop=document.getElementById('themeDrawerBackdrop');
    const close=()=>{panel.classList.remove('is-open');backdrop.classList.remove('is-open');panel.setAttribute('aria-hidden','true')};
    const open=()=>{panel.classList.add('is-open');backdrop.classList.add('is-open');panel.setAttribute('aria-hidden','false');panel.querySelector('[data-theme-tab].is-active')?.focus()};
    window.OpenJudgeTheme={open,close,getState:()=>({...state}),apply:set};
    backdrop.addEventListener('click',close);panel.querySelector('.theme-drawer-close').addEventListener('click',close);
    panel.querySelectorAll('[data-theme-tab]').forEach(button=>button.addEventListener('click',()=>{
      panel.querySelectorAll('[data-theme-tab]').forEach(item=>item.classList.toggle('is-active',item===button));
      panel.querySelectorAll('[data-theme-pane]').forEach(pane=>pane.hidden=pane.dataset.themePane!==button.dataset.themeTab);
    }));
    panel.querySelectorAll('[data-theme]').forEach(input=>input.addEventListener('input',()=>set({[input.dataset.theme]:input.type==='range'?Number(input.value):input.value})));
    panel.querySelector('.theme-reset').addEventListener('click',()=>set({...defaults}));
    const translationSettings=panel.querySelector('[data-theme-deepseek]'),legacySettings=document.getElementById('settingsDialog');
    if(!legacySettings)translationSettings.hidden=true;else translationSettings.addEventListener('click',()=>{close();legacySettings.showModal()});
    document.addEventListener('keydown',event=>{if(event.key==='Escape')close()});
  };
  const refreshFields=()=>document.querySelectorAll('[data-theme]').forEach(input=>{const value=state[input.dataset.theme];if(value!==undefined&&input.value!==String(value))input.value=value;const output=input.parentElement?.querySelector('output');if(output){const labels={radius:'px',shadow:'',control:'px',contentScale:'×',motion:' ms'};output.value=`${input.dataset.theme==='contentScale'?Number(value).toFixed(2):value}${labels[input.dataset.theme]||''}`}});
  const makeSettings=()=>{
    let button=document.getElementById('settingsOpen');
    if(!button){button=document.createElement('button');button.id='settingsOpen';button.type='button';const menu=document.querySelector('.account-menu,.theme-user-menu');(menu?.parentElement||document.querySelector('header'))?.insertBefore(button,menu||null)}
    button.classList.add('theme-settings-button');button.title='设置';button.setAttribute('aria-label','设置');button.textContent=icon('settings');button.onclick=null;
    document.addEventListener('click',event=>{if(!event.target.closest('#settingsOpen'))return;event.preventDefault();event.stopImmediatePropagation();window.OpenJudgeTheme?.open()},true);
  };
  const makeUser=()=>{
    const menu=document.querySelector('.account-menu');
    if(menu){menu.classList.add('theme-user-menu');const summary=menu.querySelector('summary');setAvatar(summary);new MutationObserver(()=>setAvatar(summary)).observe(summary,{childList:true,characterData:true,subtree:true});return}
    const user=document.createElement('details');user.className='theme-user-menu';user.innerHTML='<summary data-tj-initials="访" aria-label="账号" title="账号">访</summary><div><a href="/home">账号 / 登录</a><a href="/catalog">我的目录</a></div>';document.querySelector('header')?.append(user);
  };
  const boot=()=>{set(state,false);drawer();makeUser();makeSettings();set(state,false);refreshFields()};
  window.addEventListener('storage',event=>{if(event.key===key){state=safeRead();set(state,false)}});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
