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
    }

    let login_url: url::Url = "https://api.weibo.com/chat#/chat"
        .parse()
        .map_err(|e: url::ParseError| e.to_string())?;

    let app_handle = app.clone();

    let _login_win = WebviewWindowBuilder::new(
        &app,
        "login",
        tauri::WebviewUrl::External(login_url),
    )
    .title("微博登录 - 请扫码")
    .inner_size(420.0, 600.0)
    .initialization_script(
        r#"
        (function() {
            let detected = false;
            setInterval(function() {
                if (detected) return;
                try {
                    var text = document.body.innerText || '';
                    if (!text.includes('扫描登录') && !text.includes('立即注册') && text.length > 500) {
                        detected = true;
                        window.location.href = 'http://127.0.0.1:3456/__login_ok__';
                    }
                } catch(e) {}
            }, 2000);
        })();
        "#,
    )
    .on_navigation(move |url| {
        if url.path() == "/__login_ok__" {
            let handle = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = do_extract_cookies(handle).await {
                    eprintln!("[login] Cookie extraction failed: {}", e);
                }
            });
            return false;
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
                    all_cookies.push(CookieEntry {
                        name: c.name().to_string(),
                        value: c.value().to_string(),
                        domain: c.domain().unwrap_or("").to_string(),
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

fn find_cookie_path(_app: &tauri::AppHandle) -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent().unwrap_or(std::path::Path::new(".")).to_path_buf();
        loop {
            let candidate = dir.join("cookies.json");
            if dir.join("viewer-server.js").exists() {
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
        if dir.join("viewer-server.js").exists() {
            return dir.join("cookies.json");
        }
        if !dir.pop() {
            break;
        }
    }
    cwd.join("cookies.json")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![open_login_window])
        .setup(|app| {
            let sidecar_command = app
                .shell()
                .sidecar("viewer-server")
                .expect("failed to create sidecar command");

            let (mut rx, child) = sidecar_command
                .spawn()
                .expect("Failed to spawn sidecar");

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
                            if text.contains("3456") && !server_ready {
                                server_ready = true;
                                eprintln!("[tauri] Server ready, navigating...");
                                if let Some(win) = app_handle.get_webview_window("main") {
                                    let url: url::Url = "http://127.0.0.1:3456".parse().unwrap();
                                    let _ = win.navigate(url);
                                }
                            }
                        }
                        CommandEvent::Stderr(line) => {
                            let text = String::from_utf8_lossy(&line);
                            eprintln!("[sidecar:err] {}", text.trim());
                        }
                        CommandEvent::Terminated(payload) => {
                            eprintln!("[sidecar] terminated: {:?}", payload);
                            break;
                        }
                        _ => {}
                    }
                }
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
