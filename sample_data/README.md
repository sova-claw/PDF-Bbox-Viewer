# Sample Data

This folder contains a real PDF + CSV pair used for coordinate mapping tests.

- `1_J0948_62043.pdf` - source drawing PDF
- `1_J0948_62043.csv` - detections with `x0,y0,x1,y1` and page columns
- `Doors-v1.pdf` - demo PDF used by **Load demo — Doors PDF + JSON**
- `1_J0948_62043` pair - demo files used by **Load demo — Drawing PDF + CSV**

CSV import notes:

- Choose the CSV in the UI with **Upload CSV File** (or use **Load demo — Drawing PDF + CSV**).
- Load the matching PDF and click **Load**.
- After parsing, CSV rows use the same top-left mapper as JSON: `viewport px = csv units × scale`.
