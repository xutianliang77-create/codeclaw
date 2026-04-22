#!/usr/bin/env python3

import argparse
import importlib.util
import json
import os
import re
import signal
import sys
from typing import Dict, Iterable, List, Optional, Tuple

from multilspy import SyncLanguageServer
from multilspy.multilspy_config import Language, MultilspyConfig
from multilspy.multilspy_logger import MultilspyLogger
from multilspy.multilspy_types import SymbolKind
from multilspy.lsp_protocol_handler.server import LanguageServerHandler

LANGUAGE_EXTENSION_MAP = {
    Language.TYPESCRIPT: {".ts", ".tsx"},
    Language.JAVASCRIPT: {".js", ".jsx", ".mjs", ".cjs"},
    Language.PYTHON: {".py"},
    Language.JAVA: {".java"},
    Language.KOTLIN: {".kt", ".kts"},
    Language.RUST: {".rs"},
    Language.CSHARP: {".cs"},
    Language.GO: {".go"},
    Language.RUBY: {".rb"},
}
SUPPORTED_EXTENSIONS = set().union(*LANGUAGE_EXTENSION_MAP.values())
SKIPPED_DIRECTORIES = {
    ".git",
    "node_modules",
    "dist",
    ".next",
    "coverage",
    ".venv",
    ".venv-lsp",
    "__pycache__",
}
MAX_FILES = 800
MAX_SYMBOL_RESULTS = 20
MAX_REFERENCE_RESULTS = 40
MAX_LANGUAGE_CANDIDATES = 3
MAX_REFERENCE_ANCHORS = 5
BRIDGE_TIMEOUT_SECONDS = int(os.environ.get("CODECLAW_MULTILSPY_TIMEOUT_SECONDS", "45"))


def emit(payload, exit_code=0):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.write("\n")
    raise SystemExit(exit_code)


def emit_error(message, exit_code=1):
    emit({"error": {"message": message}}, exit_code)


def has_multilspy():
    return importlib.util.find_spec("multilspy") is not None


def normalize_snippet(line):
    return re.sub(r"\s+", " ", line.strip())


def should_skip_dir(name):
    return name in SKIPPED_DIRECTORIES


def get_language_for_extension(extension):
    for language, extensions in LANGUAGE_EXTENSION_MAP.items():
        if extension in extensions:
            return language
    return None


def get_language_for_relative_path(relative_path):
    return get_language_for_extension(os.path.splitext(relative_path)[1])


def iter_source_files(workspace):
    count = 0
    for root, dirs, files in os.walk(workspace):
        dirs[:] = [name for name in dirs if not should_skip_dir(name)]
        for file_name in files:
            if os.path.splitext(file_name)[1] not in SUPPORTED_EXTENSIONS:
                continue
            absolute_path = os.path.join(root, file_name)
            relative_path = os.path.relpath(absolute_path, workspace).replace("\\", "/")
            yield absolute_path, relative_path
            count += 1
            if count >= MAX_FILES:
                return


def normalize_symbol_kind(kind_value):
    kind_map = {
        int(SymbolKind.Function): "function",
        int(SymbolKind.Method): "method",
        int(SymbolKind.Class): "class",
        int(SymbolKind.Interface): "interface",
        int(SymbolKind.Enum): "enum",
        int(SymbolKind.Variable): "variable",
        int(SymbolKind.Constant): "const",
        int(SymbolKind.Module): "module",
        int(SymbolKind.Namespace): "namespace",
        int(SymbolKind.Struct): "c-family",
    }
    return kind_map.get(int(kind_value), "variable")


def read_line_snippet(workspace, relative_path, one_based_line):
    absolute_path = os.path.join(workspace, relative_path)
    try:
        with open(absolute_path, "r", encoding="utf-8") as handle:
            lines = handle.read().splitlines()
    except OSError:
        return ""

    if 1 <= one_based_line <= len(lines):
        return normalize_snippet(lines[one_based_line - 1])
    return ""


def detect_primary_language(workspace):
    counts = get_language_counts(workspace)
    if not counts:
        return None
    language, count = max(counts.items(), key=lambda item: item[1])
    if count <= 0:
        return None
    return language


def get_language_counts(workspace):
    counts = {language: 0 for language in LANGUAGE_EXTENSION_MAP}
    for absolute_path, _relative_path in iter_source_files(workspace):
        language = get_language_for_extension(os.path.splitext(absolute_path)[1])
        if language is not None:
            counts[language] += 1
    return counts


def detect_candidate_languages(workspace, anchors=None):
    counts = get_language_counts(workspace)
    ranked_languages = []
    seen = set()

    for anchor in anchors or []:
        language = get_language_for_relative_path(anchor["file"])
        if language is None or counts.get(language, 0) <= 0 or language in seen:
            continue
        seen.add(language)
        ranked_languages.append(language)

    remaining = sorted(
        (
            (language, count)
            for language, count in counts.items()
            if count > 0 and language not in seen
        ),
        key=lambda item: (-item[1], str(item[0])),
    )
    for language, _count in remaining:
        ranked_languages.append(language)
        if len(ranked_languages) >= MAX_LANGUAGE_CANDIDATES:
            break

    return ranked_languages[:MAX_LANGUAGE_CANDIDATES]


def should_use_document_symbol_query(language):
    return language in {Language.TYPESCRIPT, Language.JAVASCRIPT}


def score_name(name, query):
    lower_name = name.lower()
    lower_query = query.lower()
    if lower_name == lower_query:
        return 0
    if lower_name.startswith(lower_query):
        return 1
    if lower_query in lower_name:
        return 2
    return 3


def rank_symbol(symbol, query):
    return (
        score_name(symbol["name"], query),
        len(symbol["file"].split("/")),
        symbol["file"],
        symbol["line"],
        symbol["column"],
    )


def rank_reference(reference, anchor_files):
    return (
        0 if reference["relation"] == "definition" else 1,
        0 if reference["file"] in anchor_files else 1,
        len(reference["file"].split("/")),
        reference["file"],
        reference["line"],
        reference["column"],
    )


def scan_symbol_definitions(workspace, query):
    lower_query = query.lower()
    pattern = re.compile(rf"\b{re.escape(query)}\b")
    results = []

    for absolute_path, relative_path in iter_source_files(workspace):
        try:
            with open(absolute_path, "r", encoding="utf-8") as handle:
                lines = handle.read().splitlines()
        except OSError:
            continue

        for line_index, line in enumerate(lines, start=1):
            if lower_query not in line.lower():
                continue
            if not pattern.search(line):
                continue

            results.append(
                {
                    "name": query,
                    "kind": "function",
                    "file": relative_path,
                    "line": line_index,
                    "column": line.find(query) + 1,
                    "snippet": normalize_snippet(line),
                }
            )

    results.sort(key=lambda item: rank_symbol(item, query))
    return results[:MAX_SYMBOL_RESULTS]


def scan_references(workspace, query):
    pattern = re.compile(rf"\b{re.escape(query)}\b")
    results = []
    seen = set()

    for absolute_path, relative_path in iter_source_files(workspace):
        try:
            with open(absolute_path, "r", encoding="utf-8") as handle:
                lines = handle.read().splitlines()
        except OSError:
            continue

        for line_index, line in enumerate(lines, start=1):
            if not pattern.search(line):
                continue

            dedupe_key = f"{relative_path}:{line_index}"
            if dedupe_key in seen:
                continue
            seen.add(dedupe_key)
            results.append(
                {
                    "relation": "reference",
                    "file": relative_path,
                    "line": line_index,
                    "column": line.find(query) + 1,
                    "snippet": normalize_snippet(line),
                }
            )

    results.sort(key=lambda item: (item["file"], item["line"], item["column"]))
    return results[:MAX_REFERENCE_RESULTS]


def build_symbol_from_workspace_item(workspace, item):
    location = item.get("location")
    if not location:
        return None
    relative_path = location.get("relativePath")
    if not relative_path:
        return None
    line = location["range"]["start"]["line"] + 1
    column = location["range"]["start"]["character"] + 1
    return {
        "name": item["name"],
        "kind": normalize_symbol_kind(item["kind"]),
        "file": relative_path,
        "line": line,
        "column": column,
        "snippet": read_line_snippet(workspace, relative_path, line),
    }


def build_symbol_from_document_item(workspace, relative_path, item):
    target_range = item.get("selectionRange") or item.get("range")
    if target_range is None:
        return None
    line = target_range["start"]["line"] + 1
    column = target_range["start"]["character"] + 1
    return {
        "name": item["name"],
        "kind": normalize_symbol_kind(item["kind"]),
        "file": relative_path,
        "line": line,
        "column": column,
        "snippet": read_line_snippet(workspace, relative_path, line),
    }


def build_reference_from_location(workspace, location, relation):
    relative_path = location.get("relativePath")
    if not relative_path:
        return None
    line = location["range"]["start"]["line"] + 1
    column = location["range"]["start"]["character"] + 1
    return {
        "relation": relation,
        "file": relative_path,
        "line": line,
        "column": column,
        "snippet": read_line_snippet(workspace, relative_path, line),
    }


def get_anchor_candidates(workspace, query):
    candidates = scan_symbol_definitions(workspace, query)
    if not candidates:
        return []
    anchors = []
    seen = set()
    for candidate in candidates:
        dedupe_key = (candidate["file"], candidate["line"], candidate["column"])
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        anchors.append(
            {
                "file": candidate["file"],
                "line": candidate["line"] - 1,
                "column": max(candidate["column"] - 1, 0),
            }
        )
        if len(anchors) >= MAX_REFERENCE_ANCHORS:
            break
    return anchors


def create_language_server(workspace, language):
    config = MultilspyConfig(code_language=language, trace_lsp_communication=False)
    logger = MultilspyLogger()
    return SyncLanguageServer.create(config, logger, workspace, timeout=30)


def dedupe_symbols(symbols):
    deduped = []
    seen = set()
    for symbol in symbols:
        dedupe_key = (symbol["name"], symbol["file"], symbol["line"], symbol["column"], symbol["kind"])
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        deduped.append(symbol)
    return deduped


def query_symbols_via_lsp(workspace, query):
    languages = detect_candidate_languages(workspace)
    if not languages:
        raise RuntimeError("no multilspy-supported source files found in workspace")

    symbols = []
    errors = []
    for language in languages:
        try:
            server = create_language_server(workspace, language)
            with server.start_server():
                if should_use_document_symbol_query(language):
                    for _absolute_path, relative_path in iter_source_files(workspace):
                        extension = os.path.splitext(relative_path)[1]
                        if extension not in LANGUAGE_EXTENSION_MAP.get(language, set()):
                            continue
                        response, _tree = server.request_document_symbols(relative_path)
                        for item in response:
                            if query.lower() not in item["name"].lower():
                                continue
                            symbol = build_symbol_from_document_item(workspace, relative_path, item)
                            if symbol is not None:
                                symbols.append(symbol)
                else:
                    response = server.request_workspace_symbol(query) or []
                    for item in response:
                        symbol = build_symbol_from_workspace_item(workspace, item)
                        if symbol is not None:
                            symbols.append(symbol)
        except Exception as error:
            errors.append(f"{language}: {error}")
            continue

    deduped = dedupe_symbols(symbols)
    deduped.sort(key=lambda item: rank_symbol(item, query))
    if deduped:
        return deduped[:MAX_SYMBOL_RESULTS]
    if errors:
        raise RuntimeError("; ".join(errors))
    return []


def query_definitions_via_lsp(workspace, query):
    anchors = get_anchor_candidates(workspace, query)
    if not anchors:
        return []

    definitions = []
    seen = set()
    errors = []
    languages = detect_candidate_languages(workspace, anchors)
    for language in languages:
        relevant_anchors = [
            anchor for anchor in anchors if get_language_for_relative_path(anchor["file"]) == language
        ]
        if not relevant_anchors:
            continue
        try:
            server = create_language_server(workspace, language)
            with server.start_server():
                for anchor in relevant_anchors:
                    response = server.request_definition(anchor["file"], anchor["line"], anchor["column"])
                    for location in response:
                        definition = build_symbol_from_workspace_item(
                            workspace,
                            {
                                "name": query,
                                "kind": int(SymbolKind.Function),
                                "location": location,
                            },
                        )
                        if definition is None:
                            continue
                        dedupe_key = (
                            definition["file"],
                            definition["line"],
                            definition["column"],
                        )
                        if dedupe_key in seen:
                            continue
                        seen.add(dedupe_key)
                        definitions.append(definition)
        except Exception as error:
            errors.append(f"{language}: {error}")
            continue

    definitions.sort(key=lambda item: rank_symbol(item, query))
    if definitions:
        return definitions[:MAX_SYMBOL_RESULTS]
    if errors:
        raise RuntimeError("; ".join(errors))
    return []


def query_references_via_lsp(workspace, query):
    anchors = get_anchor_candidates(workspace, query)
    if not anchors:
        return []

    anchor_files = {anchor["file"] for anchor in anchors}
    reference_map = {}
    errors = []
    languages = detect_candidate_languages(workspace, anchors)

    for language in languages:
        relevant_anchors = [
            anchor for anchor in anchors if get_language_for_relative_path(anchor["file"]) == language
        ]
        if not relevant_anchors:
            continue
        try:
            server = create_language_server(workspace, language)
            with server.start_server():
                for anchor in relevant_anchors:
                    definitions = server.request_definition(anchor["file"], anchor["line"], anchor["column"])
                    references = server.request_references(anchor["file"], anchor["line"], anchor["column"])

                    for location in definitions:
                        reference = build_reference_from_location(workspace, location, "definition")
                        if reference is None:
                            continue
                        dedupe_key = (
                            reference["file"],
                            reference["line"],
                            reference["column"],
                        )
                        reference_map[dedupe_key] = reference

                    for location in references:
                        reference = build_reference_from_location(workspace, location, "reference")
                        if reference is None:
                            continue
                        dedupe_key = (
                            reference["file"],
                            reference["line"],
                            reference["column"],
                        )
                        if dedupe_key not in reference_map:
                            reference_map[dedupe_key] = reference
        except Exception as error:
            errors.append(f"{language}: {error}")
            continue

    items = list(reference_map.values())
    items.sort(key=lambda item: rank_reference(item, anchor_files))
    if items:
        return items[:MAX_REFERENCE_RESULTS]
    if errors:
        raise RuntimeError("; ".join(errors))
    return []


def run_query(kind, workspace, query):
    if kind == "symbol":
        return query_symbols_via_lsp(workspace, query)
    if kind == "definition":
        return query_definitions_via_lsp(workspace, query)
    if kind == "references":
        return query_references_via_lsp(workspace, query)
    raise RuntimeError(f"unsupported bridge kind: {kind}")


def _handle_bridge_timeout(_signum, _frame):
    raise TimeoutError(f"multilspy bridge timed out after {BRIDGE_TIMEOUT_SECONDS}s")


def _safe_signal_process_tree(self, process, terminate=True):
    signal_method = "terminate" if terminate else "kill"
    try:
        getattr(process, signal_method)()
    except Exception:
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--kind", choices=["symbol", "definition", "references"], required=True)
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--query", required=True)
    args = parser.parse_args()

    if not has_multilspy():
        emit_error("multilspy is not importable in the selected Python runtime")

    workspace = os.path.abspath(args.workspace)
    query = args.query.strip()
    if not query:
        emit({"degraded": True, "items": []})

    try:
        LanguageServerHandler._signal_process_tree = _safe_signal_process_tree
        if hasattr(signal, "SIGALRM"):
            signal.signal(signal.SIGALRM, _handle_bridge_timeout)
            signal.alarm(BRIDGE_TIMEOUT_SECONDS)
        items = run_query(args.kind, workspace, query)
        if hasattr(signal, "SIGALRM"):
            signal.alarm(0)
        emit({"degraded": False, "items": items})
    except Exception as error:
        if hasattr(signal, "SIGALRM"):
            signal.alarm(0)
        # Keep the node-side fallback path in control when real LSP setup fails
        emit_error(str(error))


if __name__ == "__main__":
    main()
