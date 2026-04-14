use windows_sys::Win32::System::Console::{
    AllocConsole, GetConsoleWindow, SetConsoleCtrlHandler, SetConsoleTitleW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    SetForegroundWindow, ShowWindow, SW_HIDE, SW_RESTORE, SW_SHOW,
};

pub(crate) fn ensure_console_visible(force_console: bool) -> Result<(), String> {
    unsafe {
        register_console_handler()?;

        let console_window = GetConsoleWindow();
        if console_window == std::ptr::null_mut() {
            if !force_console {
                return Ok(());
            }

            if AllocConsole() == 0 {
                eprintln!("Warning: Failed to allocate a console window.");
                return Ok(());
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

pub(crate) fn restore_console() -> Result<(), String> {
    ensure_console_visible(true)
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
        2 => {
            let console_window = GetConsoleWindow();
            if console_window != std::ptr::null_mut() {
                ShowWindow(console_window, SW_HIDE);
            }
            1
        }
        0 | 1 | 5 | 6 => 1,
        _ => 0,
    }
}
