"""Print a source delta batch as JSON without modifying the database."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import duckdb

from loader.delta import delta_dates, read_delta
from loader.load import LoadError


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    selection = parser.add_mutually_exclusive_group(required=True)
    selection.add_argument("--date")
    selection.add_argument("--list", action="store_true")
    parser.add_argument("--plants")
    arguments = parser.parse_args(argv)
    if arguments.list:
        print(json.dumps(delta_dates(arguments.source)))
        return 0
    plants = (
        [plant.strip() for plant in arguments.plants.split(",") if plant.strip()]
        if arguments.plants
        else None
    )
    try:
        batch = read_delta(arguments.source, arguments.date, plants=plants)
    except (LoadError, OSError, ValueError, duckdb.Error) as error:
        print(f"tide-load-delta: {error}", file=sys.stderr)
        return 2
    json.dump(batch, sys.stdout, separators=(",", ":"))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
