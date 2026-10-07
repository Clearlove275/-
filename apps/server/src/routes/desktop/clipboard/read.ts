import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

// ACT: 读取也使用 POST，复用 desktopRequest 的同源校验。
export default Router().post("/", validateFields({ format: z.enum(["image"]).optional() }), (req, res) => {
  const desktop = u.desktop.getDesktopRuntime(req);
  if (req.body.format === "image") {
    const image = desktop.readClipboardImage();
    res.json(success({ image: image ? Buffer.from(image).toString("base64") : null }));
    return;
  }
  res.json(success({ text: desktop.readClipboardText() ?? "" }));
});
