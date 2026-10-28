# real python for the code execution tool's runs that the browser can't do,
# started once per session by route.ts. requests come in as json lines on
# stdin and replies go out as json lines on stdout; the code itself and its
# subprocesses get no stdin, and their output goes to files read after the run
import ast
import asyncio
import base64
import importlib
import importlib.util
import inspect
import io
import json
import linecache
import multiprocessing
import os
import re
import subprocess
import sys
import tempfile
import traceback
import types
import urllib.request

FILENAME = "<code>"
CJK_FONT_URL = "https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@Sans2.004/Sans/SubsetOTF/SC/NotoSansSC-Regular.otf"
CJK_FONT_PATH = os.path.expanduser("~/NotoSansSC-Regular.otf")
# the default torch wheels bundle gigabytes of CUDA, which there's no GPU for
TORCH_INDEX = "https://download.pytorch.org/whl/cpu"
TORCH_PACKAGES = {"torch", "torchvision", "torchaudio"}

# import names whose PyPI package is named differently (as in python-runtime.py)
PIP_NAMES = {
    "attr": "attrs",
    "bs4": "beautifulsoup4",
    "Crypto": "pycryptodome",
    "cv2": "opencv-python-headless",
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

# packages that libraries only import once a feature is used
LAZY_DEPENDENCIES = [
    (r"\bplotly\.express\b|\bpx\.", ["pandas"]),
    (r"\.plot\(|\.hist\(", ["matplotlib"]),
    (r"read_excel|to_excel|ExcelWriter", ["openpyxl"]),
]

# the code runs in a module of its own registered as __main__, so process pools
# can pickle the functions it defines; forked workers inherit them, where spawned
# ones would have to import a __main__ that isn't a file
main = types.ModuleType("__main__")
sys.modules["__main__"] = main
if "fork" in multiprocessing.get_all_start_methods():
    multiprocessing.set_start_method("fork")
# modules the code writes to its working directory can be imported
sys.path[0] = ""
# `pip` and `python` in shell commands are this interpreter's
os.environ["PATH"] = os.path.dirname(sys.executable) + os.pathsep + os.environ.get("PATH", "")
sys.set_int_max_str_digits(0)

_loop = asyncio.new_event_loop()
_charts = []
_matplotlib_ready = _plotly_ready = False
_failed_installs = set()


# --- preparing the code ---


def _convert_magics(code):
    """notebook lines: `!cmd` and `%pip ...` run in the shell, other magics do nothing"""
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


def _imports(tree):
    """top-level modules the code imports outside of try blocks"""
    names = set()

    def visit(node, in_try):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, ast.Import) and not in_try:
                names.update(alias.name.split(".")[0] for alias in child.names)
            elif isinstance(child, ast.ImportFrom) and child.level == 0 and child.module and not in_try:
                names.add(child.module.split(".")[0])
            visit(child, in_try or isinstance(child, ast.Try))

    visit(tree, False)
    return names


def _importable(name):
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return True


def _install_requirement(requirement):
    if requirement in _failed_installs:
        return
    index = ["--index-url", TORCH_INDEX] if requirement in TORCH_PACKAGES else []
    result = subprocess.run(
        [sys.executable, "-m", "pip", "install", "-q", "--disable-pip-version-check", *index, requirement],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        _failed_installs.add(requirement)
        print(f"couldn't install {requirement}: {result.stderr.strip()}", file=sys.stderr)
    importlib.invalidate_caches()


def _install(code, tree):
    missing = [PIP_NAMES.get(name, name) for name in sorted(_imports(tree)) if not _importable(name)]
    lazy = [p for pattern, packages in LAZY_DEPENDENCIES if re.search(pattern, code) for p in packages]
    for requirement in dict.fromkeys(missing + [p for p in lazy if not _importable(p)]):
        _install_requirement(requirement)


# --- displaying plots, as in python-runtime.py ---


def _setup_matplotlib():
    from matplotlib import font_manager
    import matplotlib.pyplot as plt

    try:
        if not os.path.exists(CJK_FONT_PATH):
            with urllib.request.urlopen(CJK_FONT_URL, timeout=30) as res, tempfile.NamedTemporaryFile(
                dir=os.path.dirname(CJK_FONT_PATH), delete=False
            ) as f:
                f.write(res.read())
            os.replace(f.name, CJK_FONT_PATH)
        font_manager.fontManager.addfont(CJK_FONT_PATH)
        name = font_manager.FontProperties(fname=CJK_FONT_PATH).get_name()
        plt.rcParams["font.sans-serif"].insert(0, name)
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
    _charts.append(html.replace("<head>", "<head><style>html, body {height: 100%; margin: 0}</style>", 1))


def _is_plotly_figure(value):
    return type(value).__module__.startswith("plotly.") and hasattr(value, "to_html")


def _before_run():
    global _matplotlib_ready, _plotly_ready
    if not _matplotlib_ready and _importable("matplotlib"):
        _setup_matplotlib()
        _matplotlib_ready = True
    if not _plotly_ready and _importable("plotly"):
        import plotly.io

        plotly.io.show = _show_plotly
        _plotly_ready = True


def _collect_figures():
    """the open matplotlib figures as png data urls, closing them"""
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is None:
        return []
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


# --- running ---


def _evaluate(node, mode):
    compiled = compile(node, FILENAME, mode, flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
    value = eval(compiled, main.__dict__)
    # code with top-level await compiles to a coroutine
    if compiled.co_flags & inspect.CO_COROUTINE:
        value = _loop.run_until_complete(value)
    return value


def _format_error(e):
    """the traceback from the code on, without this file's frames before it"""
    te = traceback.TracebackException(type(e), e, e.__traceback__)
    frames = list(te.stack)
    first = next((i for i, f in enumerate(frames) if f.filename == FILENAME), 0)
    te.stack = traceback.StackSummary.from_list(frames[first:])
    return "".join(te.format())


def run(code, started):
    """runs the code in __main__ and returns what to send back to the tool,
    calling started() once packages are installed and the code itself starts"""
    try:
        try:
            tree = ast.parse(code)
        except SyntaxError:
            code = _convert_magics(code)
            tree = ast.parse(code, FILENAME)
    except SyntaxError as e:
        return {"error": "".join(traceback.format_exception_only(e))}
    _install(code, tree)
    _before_run()
    started()
    linecache.cache[FILENAME] = (len(code), None, code.splitlines(True), FILENAME)

    output = {}
    try:
        last = tree.body.pop() if tree.body and isinstance(tree.body[-1], ast.Expr) else None
        _evaluate(tree, "exec")
        value = last and _evaluate(ast.Expression(last.value), "eval")
        if _is_plotly_figure(value):
            _show_plotly(value)
        elif value is not None:
            output["result"] = repr(value)
    except SystemExit as e:
        if e.code not in (None, 0):
            output["error"] = f"SystemExit: {e.code}"
    except BaseException as e:
        output["error"] = _format_error(e)

    try:
        output["images"] = _collect_figures()
    except Exception as e:
        print(f"couldn't render figures: {e}", file=sys.stderr)
    output["html"] = _charts[:]
    _charts.clear()
    return output


def _read(f):
    f.seek(0)
    # windows writes text with \r\n
    return f.read().decode(errors="replace").replace("\r\n", "\n").rstrip("\n")


def serve():
    requests = os.fdopen(os.dup(0), "r", encoding="utf-8")
    replies = os.fdopen(os.dup(1), "w", encoding="utf-8")
    logs = os.dup(2)
    os.dup2(os.open(os.devnull, os.O_RDONLY), 0)
    devnull = os.open(os.devnull, os.O_WRONLY)
    os.dup2(devnull, 1)

    def reply(message):
        replies.write(json.dumps(message) + "\n")
        replies.flush()

    for line in requests:
        with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
            os.dup2(out.fileno(), 1)
            os.dup2(err.fileno(), 2)
            try:
                output = run(json.loads(line)["code"], lambda: reply({"running": True}))
            finally:
                sys.stdout.flush()
                sys.stderr.flush()
                os.dup2(devnull, 1)
                os.dup2(logs, 2)
            reply({"stdout": _read(out), "stderr": _read(err), **output})


serve()
