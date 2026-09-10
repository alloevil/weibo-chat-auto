use tauri::Manager;
use tauri::webview::WebviewWindowBuilder;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;
use serde::Serialize;
use std::sync::Mutex;
use std::path::PathBuf;

struct SidecarChild(Mutex<Option<tauri_plugin_shell::process::CommandChild>>);

#[derive(Serialize)]
struct CookieEntry {
    name: String,
    value: String,
    domain: String,
    path: String,
    #[serde(rename = "httpOnly")]
    http_only: bool,
    secure: bool,
}

fn http_get_simple(url: &str) -> Option<String> {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::Duration;

    let path = url.strip_prefix("http://127.0.0.1:3456")?;
    let addr: std::net::SocketAddr = "127.0.0.1:3456".parse().ok()?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(2)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok()?;

    let req = format!(
        "GET {} HTTP/1.1\r\nHost: 127.0.0.1:3456\r\nConnection: close\r\n\r\n",
        path
    );
    stream.write_all(req.as_bytes()).ok()?;

    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).ok()?;
    let response = String::from_utf8_lossy(&buf);

    let body_start = response.find("\r\n\r\n")? + 4;
    Some(response[body_start..].to_string())
}

async fn do_open_login_window(app: tauri::AppHandle) -> Result<(), String> {
    eprintln!("[login] do_open_login_window called");
    if let Some(existing) = app.get_webview_window("login") {
        eprintln!("[login] Destroying old login window");
        let _ = existing.destroy();
        // destroy() is async — wait until the window is actually gone before
        // rebuilding, otherwise build() fails with "label already exists".
        for _ in 0..50 {
            if app.get_webview_window("login").is_none() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(40)).await;
        }
    }

    // Open the real chat page. Detection is DOM-based (not URL/cookie): the
    // page is only considered "logged in" when the chat list is actually
    // rendered AND no QR/scan-login prompt is present. A *stale* SUB cookie
    // makes api.weibo.com/chat show an in-page login (URL stays on
    // api.weibo.com), so URL/cookie checks would falsely close the window
    // before the user scans. The injected script navigates to a sentinel URL
    // only once the logged-in chat UI is genuinely present.
    let login_url: url::Url = "https://api.weibo.com/chat"
        .parse()
        .map_err(|e: url::ParseError| e.to_string())?;

    let app_handle = app.clone();

    let _login_win = WebviewWindowBuilder::new(
        &app,
        "login",
        tauri::WebviewUrl::External(login_url),
    )
    .title("微博登录 - 请扫码")
    .inner_size(480.0, 640.0)
    .initialization_script(
        r#"
        (function () {
            let done = false;
            function looksLoggedIn() {
                var t = (document.body && document.body.innerText) || '';
                // 出现扫码/登录提示 → 未登录，保持窗口等待扫码
                if (t.indexOf('扫描登录') >= 0 || t.indexOf('扫码') >= 0 ||
                    t.indexOf('二维码') >= 0 || t.indexOf('立即注册') >= 0 ||
                    t.indexOf('登录微博') >= 0 || t.indexOf('安全登录') >= 0) {
                    return false;
                }
                // 聊天界面特征：会话列表 DOM，或足够多的实际内容
                var hasChat = document.querySelector('[class*="session"], [class*="Session"], [class*="chat-list"], [class*="ChatList"], [class*="conversation"]');
                return !!hasChat || t.length > 800;
            }
            var timer = setInterval(function () {
                if (done) return;
                try {
                    if (looksLoggedIn()) {
                        done = true;
                        clearInterval(timer);
                        location.href = 'https://api.weibo.com/__login_ok__';
                    }
                } catch (e) {}
            }, 1500);
        })();
        "#,
    )
    .on_navigation(move |url| {
        if url.path() == "/__login_ok__" {
            let handle = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                // 给页面/网络层一点时间把认证 cookie 落地
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                if let Err(e) = do_extract_cookies(handle).await {
                    eprintln!("[login] Cookie extraction failed: {}", e);
                }
            });
            return false; // 取消导航，不真的跳到哨兵地址
        }
        true
    })
    .build()
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
async fn open_login_window(app: tauri::AppHandle) -> Result<(), String> {
    do_open_login_window(app).await
}

async fn do_extract_cookies(app: tauri::AppHandle) -> Result<(), String> {
    let login_win = app
        .get_webview_window("login")
        .ok_or("Login window not found")?;

    let domains = [
        "https://api.weibo.com",
        "https://weibo.com",
        "https://passport.weibo.com",
        "https://login.sina.com.cn",
    ];

    let mut all_cookies: Vec<CookieEntry> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for domain in &domains {
        if let Ok(url) = domain.parse::<url::Url>() {
            if let Ok(cookies) = login_win.cookies_for_url(url) {
                for c in cookies {
                    let key = format!(
                        "{}|{}",
                        c.domain().unwrap_or(""),
                        c.name()
                    );
                    if seen.contains(&key) {
                        continue;
                    }
                    seen.insert(key);
                    // Prepend a leading dot so puppeteer's setCookie treats
                    // these as domain cookies (sent to subdomains like
                    // api.weibo.com), not host-only cookies. WKWebView returns
                    // bare domains ("weibo.com") but the archiver hits
                    // api.weibo.com, which needs ".weibo.com" to receive SUB.
                    let raw_domain = c.domain().unwrap_or("");
                    let domain = if !raw_domain.is_empty()
                        && !raw_domain.starts_with('.')
                        && raw_domain.contains('.')
                    {
                        format!(".{}", raw_domain)
                    } else {
                        raw_domain.to_string()
                    };
                    all_cookies.push(CookieEntry {
                        name: c.name().to_string(),
                        value: c.value().to_string(),
                        domain,
                        path: c.path().unwrap_or("/").to_string(),
                        http_only: c.http_only().unwrap_or(false),
                        secure: c.secure().unwrap_or(false),
                    });
                }
            }
        }
    }

    if all_cookies.is_empty() {
        return Err("No cookies found".into());
    }

    let cookie_path = find_cookie_path(&app);
    let json = serde_json::to_string_pretty(&all_cookies).map_err(|e| e.to_string())?;
    std::fs::write(&cookie_path, &json).map_err(|e| e.to_string())?;
    // cookies.json holds the full Weibo login session (SUB etc.); default
    // permissions (0644) let any local user read it. fs::write keeps the
    // existing mode on overwrite, so tighten explicitly after writing.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&cookie_path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }

    eprintln!("[login] Saved {} cookies to {:?}", all_cookies.len(), cookie_path);

    login_win.close().ok();

    if let Some(main_win) = app.get_webview_window("main") {
        main_win
            .eval(&format!(
                "window.dispatchEvent(new CustomEvent('cookies-saved', {{detail: {{count: {}}}}}));",
                all_cookies.len()
            ))
            .ok();
    }

    Ok(())
}

fn find_cookie_path(app: &tauri::AppHandle) -> PathBuf {
    // 开发形态：从可执行文件向上找仓库根（scripts/viewer-server.js 为标记）
    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent().unwrap_or(std::path::Path::new(".")).to_path_buf();
        loop {
            let candidate = dir.join("cookies.json");
            if dir.join("scripts").join("viewer-server.js").exists() {
                return candidate;
            }
            if !dir.pop() {
                break;
            }
        }
    }
    let cwd = std::env::current_dir().unwrap_or_default();
    let mut dir = cwd.clone();
    loop {
        if dir.join("scripts").join("viewer-server.js").exists() {
            return dir.join("cookies.json");
        }
        if !dir.pop() {
            break;
        }
    }
    // 打包后的 .app 不含 scripts/，而 Finder 启动的进程 cwd 是 "/"，
    // 落到 cwd/cookies.json 会 EACCES、登录后静默写盘失败。
    // 收敛到应用数据目录；同一路径通过 WEIBO_COOKIE_FILE 传给 sidecar，
    // 保证 Rust 写的与 Node 读的是同一个文件。
    if let Ok(dir) = app.path().app_data_dir() {
        std::fs::create_dir_all(&dir).ok();
        return dir.join("cookies.json");
    }
    cwd.join("cookies.json")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![open_login_window])
        .setup(|app| {
            // 端口预占探测：同时挡两种情况 —— ①第二个实例（无 single-instance
            // 插件时必然抢端口）；②端口被其它本地进程占用。被占就不启动 sidecar
            // 直接退出，否则窗口会永远空白（sidecar 起不来）。
            // 探测后立刻释放给 sidecar，中间有极小竞态窗口，可接受。
            if std::net::TcpListener::bind(("127.0.0.1", 3456)).is_err() {
                eprintln!(
                    "[tauri] 端口 3456 已被占用（可能「微博群聊」已在运行），本次退出。\
                     浏览器访问 http://localhost:3456 即可"
                );
                std::process::exit(1);
            }

            // cookies.json 的唯一约定路径：与 Rust 侧 find_cookie_path 一致，
            // 通过环境变量交给 sidecar（打包形态下两边都落在应用数据目录）
            let cookie_path = find_cookie_path(app.handle());
            let sidecar_command = match app
                .shell()
                .sidecar("viewer-server")
            {
                Ok(cmd) => cmd
                    .env("WEIBO_COOKIE_FILE", cookie_path.to_string_lossy().as_ref())
                    // 端口固定：Rust 轮询器按 3456 连接，不允许宿主环境的
                    // WEIBO_PORT 泄漏进来让两边各说各话
                    .env("WEIBO_PORT", "3456"),
                Err(e) => {
                    eprintln!("[tauri] 找不到 sidecar 可执行文件: {}", e);
                    std::process::exit(1);
                }
            };

            let (mut rx, child) = match sidecar_command.spawn() {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("[tauri] sidecar 启动失败: {}", e);
                    std::process::exit(1);
                }
            };

            app.manage(SidecarChild(Mutex::new(Some(child))));

            let app_handle = app.handle().clone();
            let app_handle2 = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut server_ready = false;
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            let text = String::from_utf8_lossy(&line);
                            eprintln!("[sidecar] {}", text.trim());
                            // 就绪判据必须是哨兵行本身：旧的"stdout 含 3456"会被
                            // 端口占用提示命中，把主窗口导航到不相干的本地进程
                            //（该 origin 还持有 core/shell 能力，等于把原生壳交给别人）。
                            // 按行匹配：stdout 事件是按读取块到达的，哨兵行未必在块首。
                            if !server_ready {
                                if let Some(port) = text.lines().find_map(|l| {
                                    l.trim()
                                        .strip_prefix("SIDECAR_READY ")
                                        .and_then(|p| p.trim().parse::<u16>().ok())
                                }) {
                                    server_ready = true;
                                    eprintln!("[tauri] Server ready, navigating...");
                                    if let Some(win) = app_handle.get_webview_window("main") {
                                        let url: url::Url = format!("http://127.0.0.1:{port}")
                                            .parse()
                                            .unwrap();
                                        let _ = win.navigate(url);
                                    }
                                }
                            }
                        }
                        CommandEvent::Stderr(line) => {
                            let text = String::from_utf8_lossy(&line);
                            eprintln!("[sidecar:err] {}", text.trim());
                        }
                        CommandEvent::Terminated(payload) => {
                            // sidecar 挂掉 = 应用只剩空白窗口。明确退出（非 0），
                            // 而不是留一个僵尸窗口；用户重开即恢复。
                            eprintln!("[sidecar] terminated unexpectedly: {:?}", payload);
                            std::process::exit(1);
                        }
                        _ => {}
                    }
                }
                // 输出流结束也算 sidecar 消亡
                eprintln!("[sidecar] output stream closed, exiting");
                std::process::exit(1);
            });

            // Poll for pending actions from the frontend
            std::thread::spawn(move || {
                // Wait for server to be ready
                loop {
                    std::thread::sleep(std::time::Duration::from_secs(1));
                    if http_get_simple("http://127.0.0.1:3456/api/pending-action").is_some() {
                        break;
                    }
                }
                eprintln!("[tauri] Action poller started");
                // Poll loop
                loop {
                    std::thread::sleep(std::time::Duration::from_secs(1));
                    if let Some(body) = http_get_simple("http://127.0.0.1:3456/api/pending-action") {
                        if body.contains("\"open_login\"") {
                            eprintln!("[tauri] Login requested via HTTP signal");
                            let handle = app_handle2.clone();
                            tauri::async_runtime::spawn(async move {
                                match do_open_login_window(handle).await {
                                    Ok(()) => eprintln!("[tauri] Login window opened"),
                                    Err(e) => eprintln!("[tauri] Failed to open login window: {}", e),
                                }
                            });
                        }
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if window.label() == "main" {
                    if let Some(state) = window.try_state::<SidecarChild>() {
                        if let Ok(mut guard) = state.0.lock() {
                            if let Some(child) = guard.take() {
                                let _ = child.kill();
                                eprintln!("[tauri] Sidecar killed");
                            }
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
