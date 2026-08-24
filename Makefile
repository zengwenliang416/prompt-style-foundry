.PHONY: dev build validate test check import-source

SOURCE_ZIP ?= ../awesome-gpt-image-2-main.zip

dev:
	python3 scripts/serve.py

import-source:
	python3 scripts/import_source.py "$(SOURCE_ZIP)"

build:
	python3 scripts/build_library.py

validate:
	python3 scripts/validate_library.py

test:
	python3 -m unittest discover -s tests -p 'test_*.py'

check: build validate test
