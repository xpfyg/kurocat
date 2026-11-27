fn main() {
    println!("cargo:rerun-if-env-changed=MINICAT_YY_THUNKS_OBJ");
    println!("cargo:rerun-if-env-changed=MINICAT_VC_LTL_LIB");
    println!("cargo:rerun-if-env-changed=MINICAT_WIN7_OLE32_SHIM_OBJ");
    #[cfg(feature = "win7")]
    {
        if let Ok(vc_ltl) = std::env::var("MINICAT_VC_LTL_LIB") {
            let trimmed = vc_ltl.trim();
            if !trimmed.is_empty() {
                println!("cargo:rustc-link-search=native={}", trimmed);
            }
        }
        if let Ok(shim) = std::env::var("MINICAT_WIN7_OLE32_SHIM_OBJ") {
            let trimmed = shim.trim();
            if !trimmed.is_empty() {
                println!("cargo:rustc-link-arg-bin=MiniCat={}", trimmed);
            }
        }
        if let Ok(obj) = std::env::var("MINICAT_YY_THUNKS_OBJ") {
            let trimmed = obj.trim();
            if !trimmed.is_empty() {
                println!("cargo:rustc-link-arg-bin=MiniCat={}", trimmed);
                println!("cargo:rustc-link-arg-bin=MiniCat=/SUBSYSTEM:WINDOWS,6.01");
            }
        }
    }
    tauri_build::build()
}
