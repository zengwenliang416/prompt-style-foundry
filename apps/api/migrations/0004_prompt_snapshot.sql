-- 0004: exact prompt text snapshot per template version (B02/J05).
-- The compiled prompt body is immutable evidence: hash-verified at import,
-- sent verbatim by the worker, and never rewritten at runtime.

ALTER TABLE template_version ADD COLUMN prompt_text text;
