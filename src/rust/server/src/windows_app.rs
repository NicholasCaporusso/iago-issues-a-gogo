use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use tray_icon::menu::{Menu, MenuEvent, MenuItem};
use tray_icon::{Icon, MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use windows_sys::Win32::System::Console::{
    AllocConsole, GetConsoleWindow, SetConsoleCtrlHandler, SetConsoleTitleW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{SetForegroundWindow, ShowWindow, SW_RESTORE, SW_SHOW};

pub(crate) struct TrayState {
    pub(crate) vault_path: PathBuf,
    pub(crate) default_port: u16,
    pub(crate) quit: Arc<AtomicBool>,
    pub(crate) repl_active: Arc<AtomicBool>,
}

pub(crate) fn start_tray_controller(state: Arc<TrayState>) -> Result<thread::JoinHandle<()>, String> {
    thread::Builder::new()
        .name("iago-server-tray".to_owned())
        .spawn(move || {
            if let Err(error) = tray_loop(state) {
                eprintln!("{error}");
            }
        })
        .map_err(|error| format!("Failed to start tray controller: {error}"))
}

pub(crate) fn show_console_and_spawn_repl(
    state: Arc<TrayState>,
    force_console: bool,
    quit_on_exit: bool,
) -> Result<(), String> {
    ensure_console_visible(force_console)?;

    if state
        .repl_active
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Ok(());
    }

    let repl_state = Arc::clone(&state);
    match thread::Builder::new()
        .name("iago-server-repl".to_owned())
        .spawn(move || {
            let result = super::run_repl_loop(
                "iago-server> ",
                &repl_state.vault_path,
                None,
                repl_state.default_port,
            );
            if let Err(error) = result {
                eprintln!("{error}");
            }
            if quit_on_exit {
                repl_state.quit.store(true, Ordering::SeqCst);
            }
            repl_state.repl_active.store(false, Ordering::SeqCst);
        })
    {
        Ok(_) => {}
        Err(error) => {
            state.repl_active.store(false, Ordering::SeqCst);
            return Err(format!("Failed to start server REPL: {error}"));
        }
    }

    Ok(())
}

fn tray_loop(state: Arc<TrayState>) -> Result<(), String> {
    let icon = load_tray_icon()?;
    let open_console = MenuItem::with_id("open-console", "Open Console", true, None);
    let quit_item = MenuItem::with_id("quit", "Quit", true, None);
    let tray_menu = Menu::with_items(&[&open_console, &quit_item])
        .map_err(|error| format!("Failed to build tray menu: {error}"))?;

    let tray_icon = TrayIconBuilder::new()
        .with_menu(Box::new(tray_menu))
        .with_tooltip("IAGO server")
        .with_menu_on_left_click(false)
        .with_icon(icon)
        .build()
        .map_err(|error| format!("Failed to create tray icon: {error}"))?;

    loop {
        if state.quit.load(Ordering::SeqCst) {
            break;
        }

        while let Ok(event) = TrayIconEvent::receiver().try_recv() {
            if let TrayIconEvent::Click {
                button,
                button_state,
                ..
            } = event
            {
                if button == MouseButton::Left && button_state == MouseButtonState::Up {
                    if let Err(error) = show_console_and_spawn_repl(Arc::clone(&state), true, false) {
                        eprintln!("{error}");
                    }
                }
            }
        }

        while let Ok(event) = MenuEvent::receiver().try_recv() {
            if event.id() == open_console.id() {
                if let Err(error) = show_console_and_spawn_repl(Arc::clone(&state), true, false) {
                    eprintln!("{error}");
                }
            } else if event.id() == quit_item.id() {
                state.quit.store(true, Ordering::SeqCst);
                break;
            }
        }

        thread::sleep(Duration::from_millis(100));
    }

    std::mem::forget(tray_icon);
    Ok(())
}

fn load_tray_icon() -> Result<Icon, String> {
    let icon_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .join("iago-icon.ico");

    Icon::from_path(icon_path, Some((32, 32)))
        .map_err(|error| format!("Failed to load tray icon: {error}"))
}

fn ensure_console_visible(force_console: bool) -> Result<(), String> {
    unsafe {
        register_console_handler()?;

        let console_window = GetConsoleWindow();
        if console_window == std::ptr::null_mut() {
            if !force_console {
                return Ok(());
            }

            if AllocConsole() == 0 {
                return Err("Failed to allocate a console window.".to_owned());
            }
            set_console_title("iago-server")?;
            return Ok(());
        }

        ShowWindow(console_window, SW_RESTORE);
        ShowWindow(console_window, SW_SHOW);
        SetForegroundWindow(console_window);
    }

    Ok(())
}

unsafe fn register_console_handler() -> Result<(), String> {
    if SetConsoleCtrlHandler(Some(console_ctrl_handler), 1) == 0 {
        return Err("Failed to register console control handler.".to_owned());
    }

    Ok(())
}

fn set_console_title(title: &str) -> Result<(), String> {
    let mut wide: Vec<u16> = title.encode_utf16().collect();
    wide.push(0);

    unsafe {
        if SetConsoleTitleW(wide.as_ptr()) == 0 {
            return Err("Failed to set console title.".to_owned());
        }
    }

    Ok(())
}

unsafe extern "system" fn console_ctrl_handler(ctrl_type: u32) -> i32 {
    match ctrl_type {
        0 | 1 | 2 | 5 | 6 => 1,
        _ => 0,
    }
}
