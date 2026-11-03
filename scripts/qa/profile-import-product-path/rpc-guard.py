"""Start the actual CLI/RPC entrypoint with all credential access disabled."""
import runpy
from jobctrl import config

def prohibited(*_args, **_kwargs):
    raise RuntimeError("credential lookup is prohibited in this synthetic test")

config.load_env = lambda: ()
config.load_native_credential_fallbacks = prohibited
config._load_native_credential_fallbacks = prohibited
config._find_macos_security_binary = lambda _name: None
runpy.run_module("jobctrl", run_name="__main__")
