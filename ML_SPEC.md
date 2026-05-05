# Argus — Specifica Tecnica: Object Detection per Coltivazioni Illecite
## ML Training Guide & Dataset Specification

---

## 1. ANALISI FIRMA VISIVA (Dataset Immagini 0-6)

### 1.1 Morfologia / Geometria (Immagini 0, 5)
- **Pattern**: Rettangoli o quadrati perfetti che interrompono la casualità del bosco
- **Dimensione tipica**: 10x10m – 50x50m a seconda della scala
- **Orientamento**: Spesso allineati con pendenza del terreno o corsi d'acqua
- **Discriminante chiave**: Bordi netti e rettilinei vs. bordi organici della vegetazione naturale

### 1.2 Tessitura e Pattern (Immagini 2, 3, 5)
- **Pattern a griglia**: Punti scuri equidistanti (piante singole) su sfondo più chiaro
- **Spaziatura**: 0.5m – 2m tra piante (visibile a risoluzione >10cm/px)
- **Uniformità**: Distribuzione regolare vs. casualità della macchia mediterranea
- **Texture**: Superficie omogenea e ordinata vs. texture caotica del bosco

### 1.3 Contrasto Spettrale (Immagine 4)
- **Verde target**: RGB tipico (40-90, 80-160, 30-80) — verde scuro saturo
- **Verde circostante**: RGB tipico (80-140, 100-180, 60-120) — verde più chiaro/giallo
- **NDVI target**: 0.65 – 0.85 (vegetazione molto sana e densa)
- **NDVI circostante**: 0.30 – 0.60 (vegetazione mista/secca)
- **Stagionalità**: Picco di anomalia NDVI in estate (Giugno-Agosto)

---

## 2. DATASET DISPONIBILI (Open Source)

### 2.1 Dataset Primari Consigliati
| Dataset | URL | Note |
|---------|-----|-------|
| OpenCannabisDatabase | https://github.com/danammeansbear/OpenCannabisDatabase | ML/Precision Ag |
| DIOR Remote Sensing | https://github.com/JohnPPinto/Object_Detection_Satellite_Imagery_Yolov8_DIOR | YOLOv8 ready |
| satellite-image-deep-learning | https://github.com/satellite-image-deep-learning/datasets | Curated list |
| UAV Datasets | https://github.com/qiangsun89/UAV-datasets | Drone imagery |

### 2.2 Strategia di Augmentation del Dataset
Per espandere il dataset di 7 immagini a un dataset addestrabile (min. 500 immagini):

```python
# Augmentation pipeline (Albumentations)
import albumentations as A

transform = A.Compose([
    A.RandomRotate90(p=0.5),
    A.HorizontalFlip(p=0.5),
    A.VerticalFlip(p=0.5),
    A.RandomBrightnessContrast(brightness_limit=0.3, contrast_limit=0.3, p=0.7),
    A.HueSaturationValue(hue_shift_limit=10, sat_shift_limit=30, val_shift_limit=20, p=0.5),
    A.GaussNoise(var_limit=(10, 50), p=0.3),
    A.RandomCrop(width=640, height=640, p=0.5),
    A.Perspective(scale=(0.05, 0.1), p=0.3),
    # Simula diverse condizioni atmosferiche
    A.RandomFog(fog_coef_lower=0.1, fog_coef_upper=0.3, p=0.2),
    A.RandomShadow(p=0.3),
], bbox_params=A.BboxParams(format='yolo', label_fields=['class_labels']))
```

---

## 3. ARCHITETTURA RACCOMANDATA: YOLOv8n

### 3.1 Motivazione della Scelta
- **YOLOv8n** (nano): ottimale per oggetti piccoli in immagini ad alta risoluzione
- **Velocità**: 80+ FPS su GPU entry-level, esportabile in ONNX per browser
- **Transfer Learning**: pre-addestrato su COCO, fine-tuning su dataset agricolo
- **Alternativa**: YOLOv8s per maggiore accuratezza se si dispone di GPU

### 3.2 Configurazione Training

```yaml
# argus_dataset.yaml
path: ./dataset
train: images/train
val:   images/val
test:  images/test

nc: 3  # numero classi
names:
  0: coltivazione_illecita      # target principale
  1: area_sospetta              # zona da verificare
  2: falso_positivo_vegetazione # vegetazione densa non target
```

```python
# train.py — Fine-tuning YOLOv8n
from ultralytics import YOLO

# Carica modello pre-addestrato su COCO
model = YOLO('yolov8n.pt')

# Fine-tuning sul dataset Argus
results = model.train(
    data    = 'argus_dataset.yaml',
    epochs  = 100,
    imgsz   = 640,
    batch   = 16,
    lr0     = 0.001,
    lrf     = 0.01,
    mosaic  = 1.0,      # augmentation mosaico
    mixup   = 0.1,
    degrees = 45,       # rotazione (coltivazioni su pendii)
    flipud  = 0.5,
    fliplr  = 0.5,
    hsv_h   = 0.015,    # variazione tonalità
    hsv_s   = 0.7,      # variazione saturazione
    hsv_v   = 0.4,      # variazione luminosità
    project = 'argus_runs',
    name    = 'detect_v1',
    device  = 'cuda'    # o 'cpu' se no GPU
)
```

### 3.3 Indici Spettrali come Feature Aggiuntive
Per migliorare la discriminazione, aggiungere canali NDVI/NDRE come input:

```python
import numpy as np

def compute_ndvi(red_band, nir_band):
    """NDVI = (NIR - RED) / (NIR + RED)"""
    ndvi = (nir_band.astype(float) - red_band.astype(float)) / \
           (nir_band.astype(float) + red_band.astype(float) + 1e-8)
    return np.clip(ndvi, -1, 1)

def compute_ndre(red_edge_band, nir_band):
    """NDRE = (NIR - RedEdge) / (NIR + RedEdge)"""
    ndre = (nir_band.astype(float) - red_edge_band.astype(float)) / \
           (nir_band.astype(float) + red_edge_band.astype(float) + 1e-8)
    return np.clip(ndre, -1, 1)

# Crea immagine 4-canale: RGB + NDVI
def create_4channel_input(rgb_img, ndvi_map):
    ndvi_norm = ((ndvi_map + 1) * 127.5).astype(np.uint8)
    return np.dstack([rgb_img, ndvi_norm])
```

---

## 4. ESPORTAZIONE ONNX E INTEGRAZIONE WEB

### 4.1 Export ONNX

```python
# export.py
from ultralytics import YOLO

model = YOLO('argus_runs/detect_v1/weights/best.pt')

# Esporta in ONNX ottimizzato per browser
model.export(
    format    = 'onnx',
    imgsz     = 640,
    opset     = 12,       # compatibile con onnxruntime-web
    simplify  = True,     # semplifica il grafo
    dynamic   = False,    # dimensioni fisse per browser
    half      = False     # FP32 per compatibilità
)
# Output: best.onnx (~6MB per YOLOv8n)
```

### 4.2 Integrazione in Argus (Vanilla JS + ONNX Runtime Web)

```html
<!-- Aggiungere in index.html -->
<script src="https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.0/dist/ort.min.js"></script>
```

```javascript
// Sostituire analyzeImageForCultivation() con inferenza ONNX reale:
async function loadONNXModel() {
    const session = await ort.InferenceSession.create('./models/argus_best.onnx', {
        executionProviders: ['wasm'],  // WebAssembly per browser
        graphOptimizationLevel: 'all'
    });
    return session;
}

async function runONNXDetection(imageData, session) {
    // Pre-processing: resize a 640x640, normalizza [0,1]
    const tensor = preprocessImage(imageData, 640, 640);
    const feeds  = { images: tensor };
    const output = await session.run(feeds);
    return postprocessYOLO(output, 0.5, 0.45); // conf=0.5, iou=0.45
}
```

---

## 5. PIPELINE COMPLETA DI ADDESTRAMENTO

```
Dataset (7 img) 
    → Annotazione manuale (LabelImg/Roboflow)
    → Augmentation x70 (500+ immagini)
    → Split 70/20/10 (train/val/test)
    → Fine-tuning YOLOv8n (100 epochs)
    → Valutazione (mAP@0.5 target: >0.70)
    → Export ONNX (best.onnx ~6MB)
    → Integrazione Argus (onnxruntime-web)
    → Deploy PWA
```

### 5.1 Metriche Target
| Metrica | Target | Note |
|---------|--------|-------|
| mAP@0.5 | > 0.70 | Precision-Recall area |
| Precision | > 0.75 | Falsi positivi accettabili |
| Recall | > 0.65 | Priorità: non perdere target |
| Inference time | < 500ms | Su dispositivo mobile |
| Modello size | < 10MB | Per PWA offline |

---

## 6. STRUMENTI CONSIGLIATI (Tutti Gratuiti)

| Tool | Uso | URL |
|------|-----|-----|
| Roboflow (free tier) | Annotazione + augmentation | roboflow.com |
| Google Colab | Training GPU gratuito | colab.research.google.com |
| Ultralytics YOLOv8 | Framework detection | github.com/ultralytics/ultralytics |
| ONNX Runtime Web | Inferenza browser | onnxruntime.ai |
| LabelImg | Annotazione locale | github.com/HumanSignal/labelImg |

---

*Argus v2.0 — Idea di Alessandro P. — Generata da Emanuele D.*
