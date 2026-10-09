from pathlib import Path
import fitz

source = Path("attached_assets/First_Commit_PS_Final_1791519918158.pdf")
output = Path(".agents/outputs")
output.mkdir(parents=True, exist_ok=True)

document = fitz.open(source)
print(f"Pages: {document.page_count}")
for index, page in enumerate(document, start=1):
    image_path = output / f"reference-page-{index}.png"
    page.get_pixmap(matrix=fitz.Matrix(1.35, 1.35), alpha=False).save(image_path)
    print(f"{image_path} ({page.rect.width:.0f} x {page.rect.height:.0f} pt)")
