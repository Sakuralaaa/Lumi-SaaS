# Third-party notices

Lumi 出图 includes material adapted from the following open-source project.

## gpt-image2-ecommerce

- Source: https://github.com/buluslan/gpt-image2-ecommerce
- License: MIT
- Used in: `server/src/services/templates/scenes.ts` and the planner prompt in `server/src/services/planner.ts`
  (e-commerce scene templates, per-category tips, Style Lock idea, compliance-check rules — adapted and rewritten).

```
MIT License

Copyright (c) 2026 Buluu@新西楼

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## IS-Net general-use segmentation model (isnet-general-use.onnx)

Used locally for product cut-outs and product paste-back. From "Highly Accurate Dichotomous Image Segmentation"
(DIS, Xuebin Qin et al., https://github.com/xuebinqin/DIS), Apache License 2.0; ONNX export distributed by
rembg (https://github.com/danielgatis/rembg, MIT). Runtime: onnxruntime-node (MIT).
