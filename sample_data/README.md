# Sample Data

This folder contains a real PDF + CSV pair used for coordinate mapping tests.

- `1_J0948_62043.pdf` - source drawing PDF
- `1_J0948_62043.csv` - detections with `x0,y0,x1,y1` and page columns

CSV import notes:

- Choose the CSV in the UI with **Choose CSV**.
- Load the matching PDF and click **Load**.
- CSV rows are mapped using top-left pixel coordinates normalized to each page viewport.
