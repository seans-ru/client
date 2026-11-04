fn main() {
    // tauri-build embeds bundle icons into the exe (Windows resource), but only
    // watches tauri.conf.json — so icon regeneration wouldn't trigger a relink.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
