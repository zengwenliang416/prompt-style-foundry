from __future__ import annotations

import hashlib
import re
import unicodedata
from dataclasses import dataclass
from typing import Any

SCHEMA_VERSION = "1.1.0"
PROJECT_NAME = "OnePic Template Studio"
PROJECT_NAME_ZH = "一图万式"
SOURCE_PROJECT = "awesome-gpt-image-2"
SOURCE_REPOSITORY = "https://github.com/freestylefly/awesome-gpt-image-2"

SECTION_TO_CATEGORY = {
    "UI与界面": "UI & Interfaces",
    "图表与信息可视化": "Charts & Infographics",
    "海报与排版": "Posters & Typography",
    "商品与电商": "Products & E-commerce",
    "品牌与标志": "Brand & Logos",
    "建筑与空间": "Architecture & Spaces",
    "摄影与写实": "Photography & Realism",
    "插画与艺术": "Illustration & Art",
    "人物与角色": "Characters & People",
    "场景与叙事": "Scenes & Storytelling",
    "历史与古风题材": "History & Classical Themes",
    "文档与出版物": "Documents & Publishing",
    "其他应用场景": "Other Use Cases",
}

CATEGORY_ADAPTERS = {
    "UI & Interfaces": """Treat the uploaded image as the content and concept source for the interface. Infer a plausible product purpose from visible subjects and context. Use a generic, legally distinct interface language rather than cloning a real platform pixel-for-pixel. Keep labels short, readable, and internally consistent. The uploaded image may become the hero image, avatar, content card, background, or product asset, depending on the blueprint.""",
    "Charts & Infographics": """Turn only directly observable visual information into a clear infographic structure. Do not invent statistics, dates, medical claims, scientific facts, rankings, or causal conclusions that cannot be inferred from the image. Prefer 3–6 concise modules, short labels, clear arrows, and strong hierarchy. The image remains the evidence and visual anchor.""",
    "Posters & Typography": """Use the uploaded image as the poster's central subject and emotional anchor. Apply the blueprint's hierarchy, typography behavior, spacing, and art direction without copying its sample title, slogan, person, place, event, or brand. When typography is essential, generate only the minimum original copy needed for the composition.""",
    "Products & E-commerce": """Treat the most prominent object in the uploaded image as the product. Preserve its silhouette, proportions, materials, colors, packaging structure, and distinctive visible details. Do not invent prices, performance claims, certifications, ingredients, endorsements, or product functions that are not visible. Create an original commercial setting around the real product rather than replacing it with the blueprint's sample product.""",
    "Brand & Logos": """Derive the brand mood, palette, shape language, and personality from the uploaded image. If a logo or trademark is visibly present and is part of the subject, preserve it only as needed for faithful transformation; otherwise create original, legally distinct brand elements. Do not copy the blueprint's sample brand names, slogans, logos, or identity systems.""",
    "Architecture & Spaces": """Preserve the uploaded space's geometry, structural relationships, camera position, perspective, openings, major materials, and circulation cues. Apply the blueprint's architectural art direction without redesigning the space into an unrelated building. Avoid impossible geometry, duplicated openings, bent walls, and inconsistent vanishing points.""",
    "Photography & Realism": """Preserve the uploaded image's subject, identity, moment, and location while applying the blueprint's photographic direction, lens behavior, lighting, depth of field, color science, and finish. Do not replace the scene with the blueprint's sample scene. Keep anatomy, materials, reflections, and physical interactions believable.""",
    "Illustration & Art": """Translate the uploaded image into the blueprint's illustration medium, brush language, shape system, palette, texture, and abstraction level. Preserve recognizable composition and subject identity while removing photographic noise and unnecessary micro-detail. The result must feel natively illustrated, not like a filter placed over a photograph.""",
    "Characters & People": """Preserve the identity anchors of every visible person: facial structure, skin tone, hairstyle, age range, body proportions, clothing, accessories, pose, and expression unless the blueprint explicitly calls for a controlled transformation. Keep the same person consistent across every panel or view. Do not beautify them into a different person or introduce extra people without a structural need.""",
    "Scenes & Storytelling": """Preserve the uploaded scene's core event, relationships, setting, and emotional direction. Use the blueprint to strengthen cinematic staging and narrative flow, not to replace the event with an unrelated story. Add only minimal supporting details that are necessary to make the existing moment readable.""",
    "History & Classical Themes": """Use the uploaded image's subject and composition as the anchor while translating the visual world into the historical or classical language required by the blueprint. Keep period details internally coherent. Do not mix unrelated dynasties, cultures, costumes, architecture, or modern objects unless they are deliberately retained as part of the source image's concept.""",
    "Documents & Publishing": """Use the uploaded image as the publication's cover, hero visual, editorial subject, or page content. Apply the blueprint's grid, margins, hierarchy, paper behavior, and typographic system. Generate only short, credible editorial copy; do not fabricate long articles, legal text, financial data, or detailed factual claims.""",
    "Other Use Cases": """Use the uploaded image as the sole content source and apply only the blueprint's transferable visual system, layout logic, material language, and presentation method. Resolve unusual or mixed tasks conservatively and keep the original subject recognizable.""",
}

MODE_RULES = {
    "multi-panel": "If the blueprint uses a grid, sequence, contact sheet, storyboard, comparison board, exploded view, or multiple views, derive every panel from the same uploaded image. Maintain one consistent subject identity, product design, wardrobe, palette, and world across all panels.",
    "interface": "The uploaded image should be integrated into one coherent interface concept rather than merely placed behind UI chrome. Keep the interface plausible, readable, and visually distinct from any real product.",
    "infographic": "Organize the output as a compact visual explanation. Use only observable facts and short labels. Do not hallucinate numeric data.",
    "poster": "Create one finished poster, not a moodboard or process sheet, unless the blueprint explicitly requires a multi-panel poster system.",
    "product": "Keep the product as the absolute visual hero and preserve its real design.",
    "portrait": "Protect identity consistency and anatomical correctness above decorative effects.",
    "document": "Prioritize grid, margins, hierarchy, and legibility; avoid fake long-form body copy.",
    "scene": "Preserve the existing event and strengthen only its visual storytelling.",
    "single-scene": "Create one coherent finished image based on the uploaded reference.",
}

TEXT_HEAVY_CATEGORIES = {
    "UI & Interfaces",
    "Charts & Infographics",
    "Posters & Typography",
    "Brand & Logos",
    "Documents & Publishing",
}

MULTI_PANEL_PATTERNS = re.compile(
    r"(?:grid|panel|storyboard|contact sheet|triptych|diptych|multi[- ]?view|sequence|comic|"
    r"2\s*[x×]\s*3|3\s*[x×]\s*3|six[- ]panel|nine[- ]panel|exploded view|comparison board|"
    r"九宫格|六宫格|四宫格|多宫格|三联|双联|分镜|网格|多视图|动作分解|设定表|拆解板|矩阵|系列)",
    re.IGNORECASE,
)

TEXT_PATTERNS = re.compile(
    r"(?:typography|headline|subtitle|caption|copywriting|label|title|slogan|logo|poster|infographic|"
    r"interface|dashboard|menu|magazine|book cover|report|document|text|文字|标题|副标题|文案|"
    r"排版|信息图|界面|海报|品牌|标志|封面|杂志|菜单|报告|画册|签名)",
    re.IGNORECASE,
)

IMAGE_TO_IMAGE_BLUEPRINT_PATTERNS = (
    re.compile(r"(?:@image\d*|\bimage1\b|\bREFERENCE[_ -]?\d+\b|\{argument\s+name=[\"']?reference)", re.IGNORECASE),
    re.compile(
        r"\b(?:uploaded|provided)\s+"
        r"(?:(?:primary|single|only|original|reference|exact|female|male|human|main)\s+){0,3}"
        r"(?:image|photo|photograph|portrait|selfie|picture|logo|face|subject|model|person|woman|man|"
        r"girl|boy|character|product|object|artwork|design|document|recipe|reference)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:input|reference|source)\s+"
        r"(?:image|photo|photograph|portrait|selfie|picture|logo|artwork|design|document)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\boriginal\s+(?:image|photo|photograph|portrait|selfie|picture|artwork)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:using|use|from|based on|inspired exactly by|show me|transform|edit|recreate|redraw)\s+"
        r"(?:(?:the|an?|your|my)\s+)?(?:attached|original)\s+"
        r"(?:image|photo|photograph|portrait|selfie|picture)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:same|exact)\s+(?:woman|man|person|girl|boy|subject|character|face|identity|appearance)\s+"
        r"(?:as|from)\s+(?:the\s+)?reference\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:edit|transform|recreate|redraw|restyle|convert|turn)\s+(?:only\s+)?"
        r"(?:(?:this|the|your|my|uploaded|attached|provided|input|reference|source|original)\s+)?"
        r"(?:image|photo|picture|portrait|selfie|subject)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:use|using|based on|inspired exactly by)\s+(?:(?:the|an?|your|my)\s+)?"
        r"(?:uploaded|attached|provided|input|reference|source|original)\s+"
        r"(?:image|photo|photograph|portrait|selfie|picture)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\buse\s+(?:the\s+)?image\s+(?:for|as)\s+(?:a\s+|the\s+)?"
        r"(?:face|identity|pose|style|character)?\s*reference\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:image|photo|photograph|portrait|selfie|picture|logo|face|subject|model|person|woman|man|"
        r"girl|boy|character|product|object|artwork|design)\s+as\s+"
        r"(?:(?:the|an?|your|my|only|primary|exact|strict|identity|appearance)\s+){0,3}reference\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:use|using|based on|from)\s+(?:this|the)\s+"
        r"(?:character|subject|person|model|face|logo|product|object|design|artwork|pattern)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\bupload\s+(?:(?:an?|the|your|one)\s+)"
        r"(?:(?:messy|handwritten|existing|original|reference|product|brand)\s+){0,3}"
        r"(?:image|photo|photograph|portrait|selfie|picture|logo|artwork|design|document|recipe|file)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\[(?:image|foto|photo|picture|portrait|selfie|product image|product photo|logo|brand visual|"
        r"signature image|用户自拍|产品图|商品图|签名图|Logo/品牌视觉)\]",
        re.IGNORECASE,
    ),
    re.compile(
        r"(?:上传|提供)(?:的)?"
        r"(?:主要|唯一|原始|参考|精确|严格|真人|女性|男性|人物|角色|产品){0,3}"
        r"(?:图片|图像|照片|自拍|模特照片|模特|产品图|商品图|Logo|品牌视觉|签名图|人物图|角色图|"
        r"人物|角色|女性|男性|面部|人脸|主体|产品|商品|图案|文档|食谱)"
    ),
    re.compile(r"(?:输入|参考|来源|原始)(?:的)?(?:图片|图像|照片|自拍|产品图|商品图|Logo|品牌视觉|签名图|人物图|角色图)"),
    re.compile(
        r"上传(?:一张|一幅|一份|一个|该|此|这张|你的|用户的)"
        r".{0,16}?(?:图片|图像|照片|自拍|产品图|商品图|Logo|品牌视觉|签名图|人物图|角色图|文档|食谱)"
    ),
    re.compile(r"(?:原图|原始(?:图片|图像|照片)|用户自拍|用户图像|附图)"),
    re.compile(
        r"(?:图片|图像|照片|自拍|模特|人物|角色|女性面部|男性面部|人脸|产品图|商品图|Logo|品牌视觉|"
        r"签名图|图案)(?:作为|用作)?(?:唯一|主要|精确|严格|身份|外观)?(?:参考|输入)"
    ),
    re.compile(
        r"(?:将|把)(?:我|用户)?(?:上传|提供|输入)?(?:的)?"
        r"(?:图片|图像|照片|自拍|模特|人物|角色|产品图|商品图|Logo|品牌视觉|签名图).*?"
        r"(?:转换|转为|转成|改成|制作|重绘|生成)"
    ),
    re.compile(
        r"基于(?:上传|输入|参考|提供|原始)?(?:的)?"
        r"(?:图片|图像|照片|自拍|模特|人物|角色|产品图|商品图|Logo|品牌视觉|签名图)"
    ),
    re.compile(r"(?:基于(?:此|这个)|(?:使用|用)(?:此|这个|该))(?:角色|人物|主体|产品|图案|背景)"),
    re.compile(
        r"(?:从输入图中|图中的\[位置|参考图是|上传图片中的|输入的\[(?:签名图|图片|图像|照片)|"
        r"(?:绘制|重绘|转换|修改|编辑)(?:该|此|这张)(?:图|图片|图像|照片))"
    ),
    re.compile(
        r"(?:严格参考|作为严格参考|参考脸|保持我的脸(?:部)?(?:完全)?一致|"
        r"基于真实菜单图片|根据此\s*(?:重新)?生成|使用(?:已附|附加)?的?(?:角色表|角色设定表|chibi插画|立绘)|"
        r"このちびキャライラストと立ち絵|添付されたキャラクターシート|"
        r"与这张图片完美匹配|重新设计这个商品广告|这个商品广告|exact face)",
        re.IGNORECASE,
    ),
    re.compile(r"\b(?:of|about)\s+me\b|\bkeep\s+my\s+face\b", re.IGNORECASE),
)


def slugify(value: str) -> str:
    value = unicodedata.normalize("NFKD", value)
    value = value.encode("ascii", "ignore").decode("ascii").lower()
    value = re.sub(r"[^a-z0-9]+", "-", value).strip("-")
    return value or "template"


def stable_digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def detect_language(text: str) -> str:
    cjk = len(re.findall(r"[\u3400-\u9fff]", text))
    latin = len(re.findall(r"[A-Za-z]", text))
    return "zh" if cjk >= max(8, latin * 0.15) else "en"


def infer_mode(category: str, title: str, blueprint: str) -> str:
    haystack = f"{title}\n{blueprint}"
    if MULTI_PANEL_PATTERNS.search(haystack):
        return "multi-panel"
    if category == "UI & Interfaces":
        return "interface"
    if category == "Charts & Infographics":
        return "infographic"
    if category == "Posters & Typography":
        return "poster"
    if category == "Products & E-commerce":
        return "product"
    if category == "Characters & People":
        return "portrait"
    if category == "Documents & Publishing":
        return "document"
    if category in {"Scenes & Storytelling", "History & Classical Themes"}:
        return "scene"
    return "single-scene"


def infer_blueprint_input_mode(title: str, blueprint: str) -> str:
    """Classify the upstream blueprint, not the compiled OnePic runtime prompt."""
    haystack = f"{title}\n{blueprint}"
    if any(pattern.search(haystack) for pattern in IMAGE_TO_IMAGE_BLUEPRINT_PATTERNS):
        return "image-to-image"
    return "text-to-image"


def requires_text(category: str, title: str, blueprint: str) -> bool:
    if category in TEXT_HEAVY_CATEGORIES:
        return True
    return bool(TEXT_PATTERNS.search(f"{title}\n{blueprint}"))


def _text_rules(text_required: bool, language: str) -> str:
    default_language = "Simplified Chinese" if language == "zh" else "English"
    if text_required:
        return f"""Text is allowed only when it is structurally required by this template.

- Preserve clearly legible text from the uploaded image when it is central to the subject.
- When new copy is required, infer it silently from the image and keep it extremely concise.
- Use the dominant language visible in the uploaded image; if no language cue exists, default to {default_language}.
- Legacy names, slogans, prices, dates, locations, statistics, and sample copy inside the blueprint are examples only and must not be copied.
- Use an original 2–5 word title and at most one short subtitle unless the blueprint genuinely requires interface labels or a compact information system.
- Check spelling, avoid gibberish, and never display bracketed placeholders, template variables, prompt instructions, or filler text.
- Do not add credits, signatures, watermarks, hashtags, or extra decorative copy."""
    return """Do not add typography unless it is essential to the blueprint or already visible and important in the uploaded image. Never add a title, slogan, caption, watermark, signature, date, location, logo, or decorative text by default. Do not render prompt instructions or legacy placeholders as visible text."""


def compile_prompt(
    *,
    template_id: str,
    title: str,
    category: str,
    blueprint: str,
    source_kind: str,
    language: str | None = None,
    mode: str | None = None,
    blueprint_input_mode: str | None = None,
) -> str:
    language = language or detect_language(blueprint)
    mode = mode or infer_mode(category, title, blueprint)
    blueprint_input_mode = blueprint_input_mode or infer_blueprint_input_mode(title, blueprint)
    text_required = requires_text(category, title, blueprint)
    category_adapter = CATEGORY_ADAPTERS.get(category, CATEGORY_ADAPTERS["Other Use Cases"])
    mode_rule = MODE_RULES[mode]
    text_rules = _text_rules(text_required, language)
    source_label = "case prompt" if source_kind == "case" else "framework prompt"

    return f"""[System / Prompt]

You are a single-reference-image transformation assistant specialized in the visual system “{title}”.

The user will upload exactly one reference image and may provide no written instructions. Treat that image as the sole source of subject matter, identity, objects, setting, visible text, and narrative content. Complete the transformation independently.

Do not ask follow-up questions. Do not request a title, subtitle, brand name, location, second image, mask, style choice, or parameter. Use Nano Banana Pro mode when available.

Template ID: {template_id}
Template family: {category}
Template mode: {mode}
Source blueprint input mode: {blueprint_input_mode}
Source blueprint type: {source_label}

🧭 INSTRUCTION PRIORITY（指令优先级）

Apply instructions in this exact order:

1. The uploaded image controls WHAT is depicted.
2. The template-specific visual blueprint controls HOW it is depicted.
3. The common single-image rules in this prompt override every conflicting legacy instruction inside the blueprint.

Any named person, fictional character, product, brand, country, city, landmark, event, slogan, title, statistic, date, color example, camera subject, or sample wording inside the blueprint is illustrative only. Never replace the uploaded image with that example.

Any token written as [PLACEHOLDER], {{PLACEHOLDER}}, <PLACEHOLDER>, ALL_CAPS_VARIABLE, or similar legacy syntax is an AUTO field. Resolve it silently from the uploaded image. Never ask the user to fill it and never print the placeholder in the output.

🎨 STYLE RULES（风格规则）

Use the transferable visual language defined by the template-specific blueprint below: art direction, medium, abstraction level, composition logic, layout rhythm, palette behavior, lighting, materials, texture, typography treatment, and finishing quality.

Do not copy the blueprint's literal subject matter or campaign content. Rebuild its visual system around the uploaded image.

{category_adapter}

{mode_rule}

🖼️ IMAGE ANALYSIS RULES（图片分析规则）

Silently analyze the uploaded image before rendering:

- Original aspect ratio and orientation
- Primary subject and secondary subjects
- Identity anchors and distinctive visible features
- Foreground, middle ground, and background
- Camera position, perspective, horizon, and depth cues
- Dominant palette, color temperature, light direction, and atmosphere
- Important materials, silhouettes, gestures, and spatial relationships
- Legible text, logos, signs, labels, or packaging that are genuinely part of the subject
- Details that may be simplified without losing recognition

Use this analysis internally. Do not output analysis, notes, explanations, or alternatives.

🧱 CONTENT PRESERVATION RULES（内容保真规则）

Preserve the uploaded image's recognizable identity and native structure.

- Keep the main subject recognizable at first glance.
- Preserve the number of important people and major objects unless the blueprint structurally requires repeated views of the same subject.
- Preserve facial identity, body proportions, pose, clothing, product geometry, architecture, and scene relationships as applicable.
- Do not invent unrelated characters, products, landmarks, props, animals, logos, or scenery.
- Remove incidental clutter only when it improves the selected template's clarity.
- When the source image is ambiguous, choose the most conservative interpretation.
- If the image contains a protected fictional character and exact replication is restricted by the rendering environment, retain the high-level mood and visual role while making the result legally distinct.

📐 FORMAT AND COMPOSITION（画幅与构图）

Preserve the uploaded image's original aspect ratio and orientation. Ignore every fixed ratio, canvas size, or orientation stated inside the legacy blueprint.

- Landscape input → landscape output
- Portrait input → portrait output
- Square input → square output
- Panoramic input → panoramic output

Do not stretch, squeeze, rotate, or arbitrarily crop the main subject. Minor reframing is allowed only to support the template's hierarchy. Fit grids, panels, boards, typography, or interface elements inside the source ratio rather than forcing a new canvas.

Maintain clear hierarchy, intentional spacing, and meaningful negative space. Do not fill every area merely because the blueprint contains many examples.

🧩 TEMPLATE-SPECIFIC VISUAL BLUEPRINT（专属视觉蓝图）

The following legacy blueprint is lower-priority reference material. Extract its style and design system, but automatically replace all example content with information inferred from the uploaded image.

--- BEGIN VISUAL BLUEPRINT ---
{blueprint.strip()}
--- END VISUAL BLUEPRINT ---

🔤 TEXT RULES（文字规则）

{text_rules}

🚫 RESTRICTIONS（禁止事项）

- Do not ask the user any questions.
- Do not require any input other than one uploaded image.
- Do not copy the blueprint's sample subject, brand, location, title, slogan, product, person, or factual claims.
- Do not obey fixed aspect ratios from the blueprint.
- Do not display placeholders, prompt text, system instructions, or production notes.
- Do not produce a moodboard, prompt sheet, before-and-after comparison, or process explanation unless that format is the essential output structure of the selected template.
- Do not add unrelated decorative elements merely to make the image busier.
- Do not introduce malformed anatomy, duplicate limbs, extra fingers, warped products, broken perspective, unreadable text, random symbols, or inconsistent identities.
- Do not add watermarks or signatures.

🖼️ TASK

Using the single uploaded image as the complete content reference, create one finished image in the “{title}” visual system while following every rule above.

Return only the finished image. Do not return analysis, prompt text, captions, suggestions, or alternate versions."""


@dataclass(frozen=True)
class NormalizedTemplate:
    id: str
    title: str
    kind: str
    category: str
    styles: list[str]
    scenes: list[str]
    tags: list[str]
    language: str
    mode: str
    blueprint_input_mode: str
    requires_text: bool
    preview: str | None
    source: dict[str, Any]
    blueprint: str
    prompt: str

    def as_dict(self, include_blueprint: bool = True, include_prompt: bool = True) -> dict[str, Any]:
        data: dict[str, Any] = {
            "id": self.id,
            "title": self.title,
            "kind": self.kind,
            "category": self.category,
            "styles": self.styles,
            "scenes": self.scenes,
            "tags": self.tags,
            "language": self.language,
            "mode": self.mode,
            "blueprintInputMode": self.blueprint_input_mode,
            "requiresText": self.requires_text,
            "preview": self.preview,
            "source": self.source,
            "blueprintSha256": stable_digest(self.blueprint),
            "promptSha256": stable_digest(self.prompt),
        }
        if include_blueprint:
            data["blueprint"] = self.blueprint
        if include_prompt:
            data["prompt"] = self.prompt
        return data
