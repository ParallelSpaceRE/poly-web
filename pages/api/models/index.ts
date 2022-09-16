import { ModelInfo, OptionalModel, UploadForm } from "@customTypes/model";
import { Categories } from "@libs/client/Util";
import { hasRight } from "@libs/server/Authorization";
import prismaClient from "@libs/server/prismaClient";
import { deleteS3Files } from "@libs/server/s3client";
import {
  getModelFromForm,
  handlePOST,
  makeMaybeArrayToArray,
  updateModel,
} from "@libs/server/ServerFileHandling";
import { Model } from "@prisma/client";
import formidable from "formidable";
import { NextApiRequest, NextApiResponse } from "next";
import { getSession } from "next-auth/react";

export const config = {
  api: {
    bodyParser: false,
  },
};

type FormidableResult = {
  err: string;
  fields: formidable.Fields;
  files: formidable.Files;
};

const allowedMethod = ["GET", "POST", "DELETE"];

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const session = await getSession({ req });
  if (!allowedMethod.includes(req.method ?? "")) {
    res.status(405).end();
    return;
  }
  if (req.method === "GET") {
    // respone specified model info
    if (req.query.id) {
      const model = await prismaClient.model.findUnique({
        where: { id: req.query.id as string },
      });
      if (!model) {
        res.status(404).end();
        return;
      }
      res.json([makeModelInfo(model)]);
      return;
    } else if (req.query.uploader) {
      // respone specific uploader's models info
      const uploaders =
        typeof req.query.uploader === "string"
          ? [req.query.uploader]
          : req.query.uploader;
      const querys = uploaders.map((uploaderId) => {
        return {
          uploader: {
            id: uploaderId,
          },
        };
      });
      const model = await prismaClient.model.findMany({
        where: {
          OR: querys,
        },
      });
      res.json(makeModelInfos(model));
      return;
    } else if (req.query.sort) {
      let errorMessage = undefined;

      const { sort, category, filterByName, orderBy } = req.query;
      let options = {
        where: {
          name: {
            contains: filterByName?.toString(),
          },
        },
        orderBy: {
          [`${sort}`]: orderBy,
        },
      };
      if (category) {
        if (Categories.includes(category?.toString())) {
          const where = Object.assign(options.where, {
            category: category.toString().toUpperCase(),
          });

          options.where = where;
        }
      }

      const modelList = await prismaClient.model.findMany(options);

      if (modelList?.length === 0) {
        if (filterByName) {
          if (category) {
            errorMessage =
              `We couldn't find any matches for "` +
              req.query.filterByName +
              `" ` +
              "in " +
              category;
          } else {
            errorMessage =
              `We couldn't find any matches for "` +
              req.query.filterByName +
              `"`;
          }
        } else if (category) {
          errorMessage = `We couldn't find any matches in "` + category + `"`;
        }

        res.status(404).json({
          data: modelList,
          error: errorMessage,
        });
        return;
      }
      const parsedList = makeModelInfos(modelList);
      res.status(200).json({ data: parsedList, error: undefined });
      return;
    }
    const modelList = await prismaClient.model.findMany({
      orderBy: {
        createdAt: "desc",
      },
    });
    const parsedList = makeModelInfos(modelList);
    res.status(200).json(parsedList);
  } else if (req.method === "POST") {
    // authorize client then upload model. db update return model id.
    const isLogined = !!session;
    if (!isLogined) {
      res.status(401).send("Login first");
      return;
    }

    const user = await prismaClient.user.findUnique({
      where: {
        email: session.user?.email ?? undefined, // if undefined, search nothing
      },
    });
    if (user === null) {
      res.status(401).end();
      return;
    }
    if (
      // if don't have right, reply code 403.
      !hasRight(
        {
          theme: "model",
          method: "create",
        },
        user
      )
    ) {
      res.status(403).json({ ok: false, message: "로그인이 필요합니다." });
      return;
    }
    // upload to s3
    const isAdminOrDev = user.role === "ADMIN" || user.role === "DEVELOPER";
    const option: formidable.Options | undefined = isAdminOrDev
      ? { multiples: true, maxFileSize: Infinity, keepExtensions: true }
      : undefined;
    const formidable = await getFormidableFileFromReq(req, option).catch(
      (e) => "Failed"
    );
    if (typeof formidable === "string") {
      res.json({
        ok: false,
        message: "Failed to parse your request. Check your model size.",
      });
      return;
    }
    const doesFormExist = !!formidable.fields.form;
    const model: OptionalModel = {};
    model.userId = user.id;
    if (doesFormExist) {
      const form: UploadForm = JSON.parse(formidable.fields.form as string);
      updateModel(model, getModelFromForm(form));
    } else {
      model.category = "MISC"; // add if form data is not exist.
    }
    const files = makeMaybeArrayToArray<formidable.File>(formidable.files.file);
    const results = await Promise.allSettled(
      files.map((file) => handlePOST(file, model))
    );
    res.json({ results });
  } else if (req.method === "DELETE") {
    const user = await prismaClient.user.findUnique({
      where: {
        email: session?.user?.email ?? undefined, // if undefined, search nothing
      },
    });
    const modelId = Array.isArray(req.query.id)
      ? req.query.id[0]
      : req.query.id;
    if (!modelId) {
      res.status(400).json({ error: "model id query not found" });
      return;
    }
    const model = await prismaClient.model.findUnique({
      where: {
        id: modelId,
      },
    });
    if (
      !hasRight(
        {
          method: "delete",
          theme: "model",
        },
        user,
        model
      )
    ) {
      res.status(403).end();
      return;
    }
    try {
      deleteS3Files(modelId);
      await prismaClient.model.delete({
        where: {
          id: modelId,
        },
      });
      res.json({ ok: true, message: "delete success!" });
      return;
    } catch (e) {
      res.status(500).json({ ok: false, message: "Failed while deleting." });
      return;
    }
  }
}

// FOR RESPONE TO GET

const makeModelInfo: (model: Model) => ModelInfo = (model) => {
  const thumbnailSrc = model.thumbnail
    ? `/getResource/models/${model.id}/${model.thumbnail}`
    : "";
  const usdzSrc = model.modelUsdz
    ? `/getResource/models/${model.id}/${model.modelUsdz}`
    : "";
  return {
    ...model,
    modelSrc: `/getResource/models/${model.id}/${model.modelFile}`,
    thumbnailSrc,
    usdzSrc,
  };
};

const makeModelInfos: (models: Model[]) => ModelInfo[] = (models) =>
  models.map((model) => makeModelInfo(model));

// FOR RESPONE TO POST

const getFormidableFileFromReq = async (
  req: NextApiRequest,
  options?: formidable.Options
) => {
  return await new Promise<FormidableResult>((res, rej) => {
    const form = formidable(
      options ?? {
        multiples: true,
        maxFileSize: 100 << 20, // 100MB for zip file
        keepExtensions: true,
      }
    );
    form.parse(req, (err: Error, fields, files) => {
      if (err) return rej(err);
      return res({ err, fields, files });
    });
  });
};
