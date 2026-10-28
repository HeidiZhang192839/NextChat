# python side of the code execution tool, loaded by python-worker.js into its own
# namespace. user code runs in __main__ with run(), after this file has patched
# what a browser worker can't do (processes, threads, plots) into working forms
import ast
import concurrent.futures
import importlib.metadata
import importlib.util
import itertools
import keyword
import linecache
import os
import re
import shlex
import sys
import traceback
import warnings

import __main__
import micropip
import pyodide.code
import pyodide_js
import pyodide_http
from pyodide.http import pyfetch

# pyodide's default matplotlib backend needs the page DOM, which a worker doesn't have
os.environ["MPLBACKEND"] = "AGG"
# pandas warns on every import that it will need pyarrow, which pyodide doesn't have
warnings.filterwarnings("ignore", message=r"(?s).*Pyarrow will become a required dependency")

CJK_FONT_URL = "https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@Sans2.004/Sans/SubsetOTF/SC/NotoSansSC-Regular.otf"
CJK_FONT_PATH = "/usr/share/fonts/NotoSansSC-Regular.otf"
FILENAME = "<code>"

# import names whose PyPI package is named differently
PIP_NAMES = {
    "attr": "attrs",
    "bs4": "beautifulsoup4",
    "Crypto": "pycryptodome",
    "cv2": "opencv-python",
    "dateutil": "python-dateutil",
    "docx": "python-docx",
    "dotenv": "python-dotenv",
    "fitz": "pymupdf",
    "PIL": "pillow",
    "pptx": "python-pptx",
    "skimage": "scikit-image",
    "sklearn": "scikit-learn",
    "yaml": "pyyaml",
}

# packages that libraries only import once a feature is used, so the code's
# imports don't show them: (pattern in the code, pip names)
LAZY_DEPENDENCIES = [
    (r"\bplotly\.express\b|\bpx\.", ["pandas"]),
    (r"\.plot\(|\.hist\(", ["matplotlib"]),
    (r"read_excel|to_excel|ExcelWriter", ["openpyxl"]),
]

# pip options that take a value, so the value isn't mistaken for a package
PIP_VALUE_OPTIONS = {
    "-r", "--requirement", "-c", "--constraint", "-i", "--index-url",
    "--extra-index-url", "-f", "--find-links", "-t", "--target",
}


# --- processes: only `pip install` is possible, through micropip ---


def _split_command(command):
    if not isinstance(command, str):
        return [str(part) for part in command]
    try:
        return shlex.split(command)
    except ValueError:
        return command.split()


def _pip_packages(parts):
    """the packages of a `pip install` / `python -m pip install` command, else None"""
    for i, part in enumerate(parts):
        if re.fullmatch(r"pip(3(\.\d+)?)?", os.path.basename(part)):
            break
    else:
        return None
    if parts[i + 1 : i + 2] != ["install"]:
        return None
    packages, skip = [], False
    for part in parts[i + 2 :]:
        if skip:
            skip = False
        elif part.startswith("-"):
            skip = part in PIP_VALUE_OPTIONS
        else:
            packages.append(part)
    return packages


def _is_installed(requirement):
    try:
        importlib.metadata.distribution(re.split(r"[\s<>=!~\[;@]", requirement)[0])
        return True
    except importlib.metadata.PackageNotFoundError:
        return False


def _shell(command):
    """runs a shell command as far as possible: the return code and its output"""
    packages = _pip_packages(_split_command(command))
    if packages is None:
        raise OSError(
            f"can't run {command!r}: there are no processes or shell commands in "
            "this sandbox (only `pip install` works, through micropip)"
        )
    # packages named in the code are installed before it runs; ones named only
    # at runtime can't be, since installing is async
    missing = [p for p in packages if not _is_installed(p)]
    if missing:
        return 1, (
            f"ERROR: can't install {' '.join(missing)} from a subprocess here, "
            f"use `import micropip; await micropip.install({missing!r})`\n"
        )
    return 0, f"Requirement already satisfied: {' '.join(packages)}\n"


def _system(command):
    code, output = _shell(command)
    (sys.stdout if code == 0 else sys.stderr).write(output)
    return code


def _subprocess_run(args, *_, capture_output=False, check=False, text=None,
                    universal_newlines=None, encoding=None, errors=None,
                    stdout=None, stderr=None, **__):
    import subprocess

    code, output = _shell(args)
    if not (capture_output or stdout == subprocess.PIPE or stderr == subprocess.PIPE):
        (sys.stdout if code == 0 else sys.stderr).write(output)
    if not (text or universal_newlines or encoding or errors):
        output = output.encode()
    empty = output[:0]
    result = subprocess.CompletedProcess(
        args, code, output if code == 0 else empty, empty if code == 0 else output
    )
    if check:
        result.check_returncode()
    return result


def _patch_processes():
    import subprocess

    os.system = _system
    subprocess.run = _subprocess_run
    subprocess.call = lambda *a, **k: _subprocess_run(*a, **k).returncode
    subprocess.check_call = lambda *a, **k: _subprocess_run(*a, check=True, **k).returncode
    subprocess.check_output = lambda *a, **k: _subprocess_run(
        *a, check=True, capture_output=True, **k
    ).stdout


# --- threads, executors and process pools run their work one task at a time ---


def _thread_start(self):
    # a worker has no threads, so the target runs right away and start() returns
    # when it's done. daemon threads are usually endless background loops, which
    # would never return, so they keep failing (libraries like tqdm handle that)
    if self.daemon:
        raise RuntimeError("can't start a daemon thread: this sandbox has no threads")
    if not self._initialized:
        raise RuntimeError("thread.__init__() not called")
    if self._started.is_set():
        raise RuntimeError("threads can only be started once")
    self._started.set()
    try:
        self.run()
    except BaseException:
        self._invoke_excepthook(self)
    finally:
        self._is_stopped = True


class SyncExecutor(concurrent.futures.Executor):
    """stands in for ThreadPoolExecutor and ProcessPoolExecutor"""

    def __init__(self, *args, initializer=None, initargs=(), **kwargs):
        if initializer:
            initializer(*initargs)

    def submit(self, fn, /, *args, **kwargs):
        future = concurrent.futures.Future()
        try:
            future.set_result(fn(*args, **kwargs))
        except BaseException as e:
            future.set_exception(e)
        return future


class _AsyncResult:
    def __init__(self, fn, callback=None, error_callback=None):
        try:
            self._value, self._ok = fn(), True
        except Exception as e:
            self._value, self._ok = e, False
        if self._ok and callback:
            callback(self._value)
        if not self._ok and error_callback:
            error_callback(self._value)

    def get(self, timeout=None):
        if self._ok:
            return self._value
        raise self._value

    def wait(self, timeout=None):
        pass

    def ready(self):
        return True

    def successful(self):
        return self._ok


class SyncPool:
    """stands in for multiprocessing.Pool and ThreadPool"""

    def __init__(self, processes=None, initializer=None, initargs=(), *args, **kwargs):
        if initializer:
            initializer(*initargs)

    def apply(self, func, args=(), kwds={}):
        return func(*args, **kwds)

    def apply_async(self, func, args=(), kwds={}, callback=None, error_callback=None):
        return _AsyncResult(lambda: func(*args, **kwds), callback, error_callback)

    def map(self, func, iterable, chunksize=None):
        return list(map(func, iterable))

    def map_async(self, func, iterable, chunksize=None, callback=None, error_callback=None):
        return _AsyncResult(lambda: self.map(func, iterable), callback, error_callback)

    def starmap(self, func, iterable, chunksize=None):
        return list(itertools.starmap(func, iterable))

    def starmap_async(self, func, iterable, chunksize=None, callback=None, error_callback=None):
        return _AsyncResult(lambda: self.starmap(func, iterable), callback, error_callback)

    def imap(self, func, iterable, chunksize=1):
        return map(func, iterable)

    imap_unordered = imap

    def close(self):
        pass

    terminate = join = close

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        pass


class SyncProcess:
    """stands in for multiprocessing.Process"""

    def __init__(self, group=None, target=None, name=None, args=(), kwargs={}, *, daemon=None):
        self._target, self._args, self._kwargs = target, args, kwargs
        self.name, self.daemon = name or type(self).__name__, daemon
        self.exitcode = self.pid = None

    def run(self):
        if self._target:
            self._target(*self._args, **self._kwargs)

    def start(self):
        try:
            self.run()
            self.exitcode = 0
        except SystemExit as e:
            self.exitcode = e.code if isinstance(e.code, int) else 1
        except BaseException:
            traceback.print_exc()
            self.exitcode = 1

    def join(self, timeout=None):
        pass

    def is_alive(self):
        return False

    def terminate(self):
        pass

    kill = close = terminate


def _patch_concurrency():
    import concurrent.futures.thread
    import multiprocessing
    import threading
    import types

    threading.Thread.start = _thread_start
    concurrent.futures.ThreadPoolExecutor = SyncExecutor
    concurrent.futures.ProcessPoolExecutor = SyncExecutor
    concurrent.futures.thread.ThreadPoolExecutor = SyncExecutor
    multiprocessing.Pool = SyncPool
    multiprocessing.Process = SyncProcess
    # the real modules need _multiprocessing, which pyodide doesn't have
    for parent, name, attrs in [
        (concurrent.futures, "process", {"ProcessPoolExecutor": SyncExecutor}),
        (multiprocessing, "pool", {"Pool": SyncPool, "ThreadPool": SyncPool}),
    ]:
        module = types.ModuleType(f"{parent.__name__}.{name}")
        module.__dict__.update(attrs)
        sys.modules[module.__name__] = module
        setattr(parent, name, module)


# --- displaying plots ---

_charts = []
_matplotlib_ready = _plotly_ready = False


async def _setup_matplotlib():
    from matplotlib import font_manager
    import matplotlib.pyplot as plt

    try:
        res = await pyfetch(CJK_FONT_URL)
        os.makedirs(os.path.dirname(CJK_FONT_PATH), exist_ok=True)
        with open(CJK_FONT_PATH, "wb") as f:
            f.write(await res.bytes())
        font_manager.fontManager.addfont(CJK_FONT_PATH)
        name = font_manager.FontProperties(fname=CJK_FONT_PATH).get_name()
        plt.rcParams["font.sans-serif"].insert(0, name)
        # also the fallback for missing fonts like SimHei
        font_manager.fontManager.defaultFamily["ttf"] = name
    except Exception as e:
        print(f"couldn't load the Chinese font: {e}", file=sys.stderr)
    plt.rcParams["axes.unicode_minus"] = False
    # open figures are sent back after each run
    plt.show = lambda *args, **kwargs: None


def _show_plotly(fig, *args, **kwargs):
    import plotly.offline

    version = plotly.offline.get_plotlyjs_version()
    html = fig.to_html(
        include_plotlyjs=f"https://cdn.jsdelivr.net/npm/plotly.js-dist-min@{version}/plotly.min.js",
        full_html=True,
        default_height="100%",
    )
    # fill the chat's chart frame exactly, without a scrollbar
    _charts.append(html.replace("<head>", "<head><style>html, body {height: 100%; margin: 0}</style>", 1))


def _setup_plotly():
    import plotly.io

    plotly.io.show = _show_plotly


def _is_plotly_figure(value):
    return type(value).__module__.startswith("plotly.") and hasattr(value, "to_html")


def _collect_figures():
    """the open matplotlib figures as png data urls, closing them"""
    import base64
    import io

    plt = sys.modules.get("matplotlib.pyplot")
    if plt is None:
        return []
    # e.g. seaborn's set_theme() puts DejaVu Sans, which has no chinese, back in front
    fm = sys.modules["matplotlib.font_manager"]
    cjk = fm.fontManager.defaultFamily["ttf"]
    if cjk != "DejaVu Sans" and "DejaVu" in fm.findfont(fm.FontProperties(family=["sans-serif"])):
        plt.rcParams["font.sans-serif"] = [cjk] + plt.rcParams["font.sans-serif"]
    images = []
    for num in plt.get_fignums():
        buf = io.BytesIO()
        plt.figure(num).savefig(buf, format="png", bbox_inches="tight")
        images.append("data:image/png;base64," + base64.b64encode(buf.getvalue()).decode())
    plt.close("all")
    return images


# --- preparing the code ---


def _convert_magics(code):
    """notebook lines: `!cmd` and `%pip ...` become os.system(), other magics do nothing"""
    lines = code.split("\n")
    for i, line in enumerate(lines):
        m = re.match(r"(\s*)(!|%%?)(.*)", line)
        if not m:
            continue
        indent, kind, command = m.groups()
        if kind == "!" or re.match(r"pip3?\s", command):
            lines[i] = f"{indent}__import__('os').system({command!r})"
        else:
            lines[i] = f"{indent}pass  # {line.strip()}"
    return "\n".join(lines)


def _await_asyncio_run(code, tree):
    """asyncio.run() and run_until_complete() can't be used inside pyodide's running
    event loop, but top-level await can, so outside of functions they become await"""
    calls = []

    def visit(node):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)):
                continue
            func = getattr(child, "func", None)
            if (
                isinstance(child, ast.Call)
                and len(child.args) == 1
                and isinstance(func, ast.Attribute)
                and (
                    func.attr == "run_until_complete"
                    or (func.attr == "run" and isinstance(func.value, ast.Name) and func.value.id == "asyncio")
                )
            ):
                calls.append(child)
            else:
                visit(child)

    visit(tree)
    # ast offsets are utf-8 byte offsets within lines
    source = code.encode()
    line_starts = [0]
    for line in source.splitlines(keepends=True):
        line_starts.append(line_starts[-1] + len(line))

    def offset(lineno, col):
        return line_starts[lineno - 1] + col

    for call in sorted(calls, key=lambda c: (c.lineno, c.col_offset), reverse=True):
        arg = call.args[0]
        inner = source[offset(arg.lineno, arg.col_offset) : offset(arg.end_lineno, arg.end_col_offset)]
        source = (
            source[: offset(call.lineno, call.col_offset)]
            + b"(await "
            + inner
            + b")"
            + source[offset(call.end_lineno, call.end_col_offset) :]
        )
    return source.decode()


def _prepare(code):
    """the code to run, names of modules it may import and pip packages it names"""
    try:
        tree = ast.parse(code)
    except SyntaxError:
        code = _convert_magics(code)
        tree = ast.parse(code, FILENAME)
    code = _await_asyncio_run(code, tree)

    imports, strings, pip, uses_dynamic_import = set(), [], [], False

    def visit(node, in_try):
        nonlocal uses_dynamic_import
        for child in ast.iter_child_nodes(node):
            if isinstance(child, ast.Import) and not in_try:
                imports.update(alias.name.split(".")[0] for alias in child.names)
            elif isinstance(child, ast.ImportFrom) and child.level == 0 and child.module and not in_try:
                imports.add(child.module.split(".")[0])
            elif isinstance(child, ast.Constant) and isinstance(child.value, str):
                strings.append(child.value)
                for command in re.split(r"[\n;&|]", child.value):
                    pip.extend(_pip_packages(_split_command(command)) or [])
            elif isinstance(child, (ast.Name, ast.Attribute)):
                name = child.id if isinstance(child, ast.Name) else child.attr
                uses_dynamic_import |= name in ("__import__", "import_module", "find_spec")
            if isinstance(child, (ast.List, ast.Tuple)):
                parts = [e.value for e in child.elts if isinstance(e, ast.Constant) and isinstance(e.value, str)]
                pip.extend(_pip_packages(parts) or [])
            visit(child, in_try or isinstance(child, ast.Try))

    visit(tree, False)
    # e.g. importlib.import_module("pandas"): load packages named in strings too
    dynamic = (
        {s.split(".")[0] for s in strings if s.isidentifier() and not keyword.iskeyword(s)}
        if uses_dynamic_import
        else set()
    )
    return code, imports, dynamic, pip


SHELL_FUNCTIONS = {
    "os": {"system", "popen"},
    "subprocess": {"run", "call", "check_call", "check_output", "Popen", "getoutput", "getstatusoutput"},
}


def _is_pip_install(command):
    """whether a command argument is only `pip install`s, which micropip can do"""
    if isinstance(command, ast.Constant) and isinstance(command.value, str):
        lines = [c for c in re.split(r"[\n;&|]", command.value) if c.strip()]
        return bool(lines) and all(_pip_packages(_split_command(c)) is not None for c in lines)
    if isinstance(command, (ast.List, ast.Tuple)):
        # e.g. [sys.executable, "-m", "pip", "install", ...]
        parts = [e.value for e in command.elts if isinstance(e, ast.Constant) and isinstance(e.value, str)]
        return _pip_packages(parts) is not None
    return False


def _server_reason(code):
    """why the code needs real python on the server, or None if the browser can
    run it: shell commands other than `pip install`, or multiple processes"""
    tree = ast.parse(code, FILENAME)
    modules, functions = {}, {}  # local names of os/subprocess and their functions
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name in ("multiprocessing", "concurrent.futures.process"):
                    return "it uses multiple processes"
                modules[alias.asname or alias.name] = alias.name
        elif isinstance(node, ast.ImportFrom) and node.module:
            if node.module.split(".")[0] == "multiprocessing":
                return "it uses multiple processes"
            for alias in node.names:
                if alias.name == "ProcessPoolExecutor":
                    return "it uses multiple processes"
                functions[alias.asname or alias.name] = (node.module, alias.name)
        elif isinstance(node, (ast.Name, ast.Attribute)):
            if (node.id if isinstance(node, ast.Name) else node.attr) == "ProcessPoolExecutor":
                return "it uses multiple processes"

    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func, module, name = node.func, None, None
        if isinstance(func, ast.Name) and func.id in functions:
            module, name = functions[func.id]
        elif isinstance(func, ast.Attribute):
            name, value = func.attr, func.value
            if isinstance(value, ast.Name):
                module = modules.get(value.id)
            # `!cmd` lines, as _convert_magics() writes them
            elif isinstance(value, ast.Call) and getattr(value.func, "id", None) == "__import__" and value.args:
                module = getattr(value.args[0], "value", None)
        if name not in SHELL_FUNCTIONS.get(module, ()):
            continue
        command = node.args[0] if node.args else next(
            (k.value for k in node.keywords if k.arg in ("args", "command", "cmd")), None
        )
        if not _is_pip_install(command):
            return "it runs shell commands"
    return None


def _importable(name):
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):  # e.g. __main__ has no spec
        return True


async def _install(code, imports, dynamic, pip):
    """loads pyodide's packages for the code's imports, and installs what's still
    missing and the packages of `pip install` commands from PyPI"""
    for source in (code, "\n".join(f"import {name}" for name in sorted(dynamic))):
        try:
            await pyodide_js.loadPackagesFromImports(source)
        except Exception as e:
            print(f"couldn't load packages: {e}", file=sys.stderr)
    missing = [PIP_NAMES.get(name, name) for name in sorted(imports) if not _importable(name)]
    lazy = [p for pattern, packages in LAZY_DEPENDENCIES if re.search(pattern, code) for p in packages]
    for requirement in dict.fromkeys(missing + [p for p in pip + lazy if not _is_installed(p)]):
        await _install_requirement(requirement)


_failed_installs = set()


async def _install_requirement(requirement):
    if requirement in _failed_installs:
        return False
    try:
        await micropip.install(requirement)
        importlib.invalidate_caches()
        return True
    except Exception as e:
        _failed_installs.add(requirement)
        print(f"couldn't install {requirement}: {e}", file=sys.stderr)
        return False


def _missing_module(e):
    """the top-level module a ModuleNotFoundError in the exception's chain is about"""
    while e is not None:
        if isinstance(e, ModuleNotFoundError) and e.name:
            return e.name.split(".")[0]
        e = e.__cause__ or e.__context__
    return None


async def _before_run():
    global _matplotlib_ready, _plotly_ready
    # urllib and requests through the browser; the worker retries requests that
    # CORS blocks through the app's server
    pyodide_http.patch_all()
    if not _matplotlib_ready and _importable("matplotlib"):
        await _setup_matplotlib()
        _matplotlib_ready = True
    if not _plotly_ready and _importable("plotly"):
        _setup_plotly()
        _plotly_ready = True


def _format_error(e):
    """the traceback from the user's code on, without pyodide's frames before it"""
    te = traceback.TracebackException(type(e), e, e.__traceback__)
    frames = list(te.stack)
    first = next((i for i, f in enumerate(frames) if f.filename == FILENAME), 0)
    te.stack = traceback.StackSummary.from_list(frames[first:])
    return "".join(te.format())


async def run(code, server=False):
    """runs the code in __main__ and returns what to send back to the tool. with
    a server to run python on, code that needs it isn't run here, and the reason
    why is returned as "server" instead"""
    try:
        code, imports, dynamic, pip = _prepare(code)
    except SyntaxError as e:
        return {"error": "".join(traceback.format_exception_only(e))}
    reason = server and _server_reason(code)
    if reason:
        return {"server": reason}
    await _install(code, imports, dynamic, pip)
    missing = [name for name in sorted(imports) if not _importable(name)]
    if server and missing:
        return {"server": f"{', '.join(missing)} can't be installed in the browser"}
    await _before_run()
    # so tracebacks show the lines of the code
    linecache.cache[FILENAME] = (len(code), None, code.splitlines(True), FILENAME)

    output = {}
    try:
        value = await pyodide.code.eval_code_async(code, __main__.__dict__, filename=FILENAME)
        if _is_plotly_figure(value):
            _show_plotly(value)
        elif value is not None:
            output["result"] = repr(value)
    except SystemExit as e:
        if e.code not in (None, 0):
            output["error"] = f"SystemExit: {e.code}"
    except BaseException as e:
        output["error"] = _format_error(e)
        # e.g. a library importing an optional dependency. it's installed now, but
        # the code isn't rerun here, since what already ran would run twice
        missing = _missing_module(e)
        if missing and not _importable(missing) and await _install_requirement(PIP_NAMES.get(missing, missing)):
            output["error"] += f"\n{missing} wasn't installed and now is: run the code again\n"

    try:
        output["images"] = _collect_figures()
    except Exception as e:
        print(f"couldn't render figures: {e}", file=sys.stderr)
    output["html"] = _charts[:]
    _charts.clear()
    return output


_patch_processes()
_patch_concurrency()
# the 4300-digit limit on int <-> str guards servers against slow conversions,
# which only matter here as far as the run's timeout
sys.set_int_max_str_digits(0)
