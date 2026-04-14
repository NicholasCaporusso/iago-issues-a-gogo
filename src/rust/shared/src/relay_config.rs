use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

pub const DEFAULT_RELAY_PORT: u16 = 4317;
pub const RELAY_CONFIG_FILE_NAME: &str = "relay-config.json";
pub const IAGO_DATA_DIR_NAME: &str = "IAGO";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayConfig {
    #[serde(default = "default_relay_port_value")]
    pub relay_port: u16,
}

impl Default for RelayConfig {
    fn default() -> Self {
        Self {
            relay_port: DEFAULT_RELAY_PORT,
        }
    }
}

fn default_relay_port_value() -> u16 {
    DEFAULT_RELAY_PORT
}

pub fn shared_data_root() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        let local_app_data = env::var_os("LOCALAPPDATA")
            .or_else(|| env::var_os("APPDATA"))
            .ok_or_else(|| "Could not determine the local application data directory.".to_owned())?;
        return Ok(PathBuf::from(local_app_data).join(IAGO_DATA_DIR_NAME));
    }

    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(current_exe) = env::current_exe() {
            if let Some(parent) = current_exe.parent().and_then(Path::parent) {
                return Ok(parent.to_path_buf());
            }
        }

        let current_dir = env::current_dir().map_err(|error| format!("Failed to read current directory: {error}"))?;
        current_dir
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "Could not determine a shared config directory.".to_owned())
    }
}

pub fn relay_config_path() -> Result<PathBuf, String> {
    Ok(shared_data_root()?.join(RELAY_CONFIG_FILE_NAME))
}

pub fn read_relay_config() -> Result<RelayConfig, String> {
    let config_path = relay_config_path()?;

    match fs::read_to_string(&config_path) {
        Ok(contents) => {
            let raw: serde_json::Value = serde_json::from_str(&contents)
                .map_err(|error| format!("Failed to parse {}: {error}", config_path.display()))?;
            let relay_port = raw
                .get("relayPort")
                .or_else(|| raw.get("port"))
                .and_then(|value| value.as_u64())
                .map(|value| {
                    u16::try_from(value)
                        .map_err(|_| format!("Invalid relay port in {}: {value}", config_path.display()))
                })
                .transpose()?
                .unwrap_or(DEFAULT_RELAY_PORT);

            validate_relay_port(relay_port)?;
            Ok(RelayConfig { relay_port })
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(RelayConfig::default()),
        Err(error) => Err(format!("Failed to read {}: {error}", config_path.display())),
    }
}

pub fn read_relay_port() -> Result<u16, String> {
    Ok(read_relay_config()?.relay_port)
}

pub fn write_relay_config(config: &RelayConfig) -> Result<PathBuf, String> {
    let config_path = relay_config_path()?;
    write_relay_config_at(&config_path, config)
}

pub fn write_relay_config_at(config_path: &Path, config: &RelayConfig) -> Result<PathBuf, String> {
    validate_relay_port(config.relay_port)?;

    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    }

    let contents = serde_json::to_string_pretty(config)
        .map_err(|error| format!("Failed to serialize relay config: {error}"))?;
    fs::write(config_path, format!("{contents}\n"))
        .map_err(|error| format!("Failed to write {}: {error}", config_path.display()))?;
    Ok(config_path.to_path_buf())
}

pub fn write_relay_port(relay_port: u16) -> Result<PathBuf, String> {
    write_relay_config(&RelayConfig { relay_port })
}

pub fn relay_url_for_port(relay_port: u16) -> String {
    format!("http://127.0.0.1:{relay_port}")
}

pub fn validate_relay_port(relay_port: u16) -> Result<u16, String> {
    if relay_port == 0 {
        return Err("Invalid relay port: 0".to_owned());
    }

    Ok(relay_port)
}
