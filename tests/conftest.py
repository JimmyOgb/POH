# Global pytest and gltest configuration and environment fixtures

import genlayer_py.contracts.utils as utils
import genlayer_py.contracts.actions as actions

# Ensure calldata encoding always sets the canonical "method" key expected by GenVM runners
_orig_make_calldata = utils.make_calldata_object

def _patched_make_calldata(method=None, args=None, kwargs=None):
    obj = _orig_make_calldata(method=method, args=args, kwargs=kwargs)
    if method is not None and isinstance(obj, dict):
        obj["method"] = method
        obj[""] = method
    return obj

utils.make_calldata_object = _patched_make_calldata
actions.make_calldata_object = _patched_make_calldata
