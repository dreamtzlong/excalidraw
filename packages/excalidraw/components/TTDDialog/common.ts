import { DEFAULT_EXPORT_PADDING, EDITOR_LS_KEYS, randomId, ROUNDNESS } from "@excalidraw/common";
import { pointFrom } from "@excalidraw/math";

import type { MermaidConfig } from "@excalidraw/mermaid-to-excalidraw";
import type { MermaidToExcalidrawResult } from "@excalidraw/mermaid-to-excalidraw/dist/interfaces";

import { newElement, newArrowElement, newTextElement } from "@excalidraw/element";
import type { NonDeletedExcalidrawElement } from "@excalidraw/element/types";
import { Scene, bindLinearElement } from "@excalidraw/element";

import { EditorLocalStorage } from "../../data/EditorLocalStorage";
import { canvasToBlob } from "../../data/blob";
import { t } from "../../i18n";
import { convertToExcalidrawElements, exportToCanvas } from "../../index";

import type { AppClassProperties, BinaryFiles } from "../../types";

const resetPreview = ({
  canvasRef,
  setError,
}: {
  canvasRef: React.RefObject<HTMLDivElement | null>;
  setError: (error: Error | null) => void;
}) => {
  const canvasNode = canvasRef.current;

  if (!canvasNode) {
    return;
  }
  const parent = canvasNode.parentElement;
  if (!parent) {
    return;
  }
  parent.style.background = "";
  setError(null);
  canvasNode.replaceChildren();
};

export interface MermaidToExcalidrawLibProps {
  loaded: boolean;
  api: Promise<{
    parseMermaidToExcalidraw: (
      definition: string,
      config?: MermaidConfig,
    ) => Promise<MermaidToExcalidrawResult>;
  }>;
}

interface ConvertMermaidToExcalidrawFormatProps {
  canvasRef: React.RefObject<HTMLDivElement | null>;
  mermaidToExcalidrawLib: MermaidToExcalidrawLibProps;
  mermaidDefinition: string;
  setError: (error: Error | null) => void;
  data: React.MutableRefObject<{
    elements: readonly NonDeletedExcalidrawElement[];
    files: BinaryFiles | null;
  }>;
}

interface ConvertXMindToExcalidrawFormatProps {
  canvasRef: React.RefObject<HTMLDivElement | null>;
  xmindDefinition: string;
  setError: (error: Error | null) => void;
  data: React.MutableRefObject<{
    elements: readonly NonDeletedExcalidrawElement[];
    files: BinaryFiles | null;
  }>;
}

export const convertMermaidToExcalidraw = async ({
  canvasRef,
  mermaidToExcalidrawLib,
  mermaidDefinition,
  setError,
  data,
}: ConvertMermaidToExcalidrawFormatProps) => {
  const canvasNode = canvasRef.current;
  const parent = canvasNode?.parentElement;

  if (!canvasNode || !parent) {
    return;
  }

  if (!mermaidDefinition) {
    resetPreview({ canvasRef, setError });
    return;
  }

  try {
    const api = await mermaidToExcalidrawLib.api;

    let ret;
    try {
      // 预处理：将 HTML 换行标签替换为普通换行，避免解析/渲染阶段出现 text 相关异常
      const sanitizedDefinition = mermaidDefinition
        .replace(/<br\s*\/?\>/gi, "\n")
        .trim();

      ret = await api.parseMermaidToExcalidraw(sanitizedDefinition);
    } catch (err: any) {
      const sanitizedFallback = mermaidDefinition
        .replace(/<br\s*\/?\>/gi, "\n")
        .replace(/"/g, "'")
        .trim();

      ret = await api.parseMermaidToExcalidraw(sanitizedFallback);
    }
    const { elements, files } = ret;
    setError(null);

    data.current = {
      elements: convertToExcalidrawElements(elements, {
        regenerateIds: true,
      }),
      files,
    };

    const canvas = await exportToCanvas({
      elements: data.current.elements,
      files: data.current.files,
      exportPadding: DEFAULT_EXPORT_PADDING,
      maxWidthOrHeight:
        Math.max(parent.offsetWidth, parent.offsetHeight) *
        window.devicePixelRatio,
    });
    // if converting to blob fails, there's some problem that will
    // likely prevent preview and export (e.g. canvas too big)
    try {
      await canvasToBlob(canvas);
    } catch (e: any) {
      if (e.name === "CANVAS_POSSIBLY_TOO_BIG") {
        throw new Error(t("canvasError.canvasTooBig"));
      }
      throw e;
    }
    parent.style.background = "var(--default-bg-color)";
    canvasNode.replaceChildren(canvas);
  } catch (err: any) {
    parent.style.background = "var(--default-bg-color)";
    if (mermaidDefinition) {
      setError(err);
    }

    throw err;
  }
};

interface MindmapNode {
  topic: string;
  children?: MindmapNode[];
}

const clampMindmapTree = (node: MindmapNode, depth: number = 0): MindmapNode => {
  const MAX_DEPTH = 3;
  const MAX_CHILDREN_LEVEL1 = 6;
  const MAX_CHILDREN_OTHER = 4;

  const maxChildren = depth === 0 ? MAX_CHILDREN_LEVEL1 : MAX_CHILDREN_OTHER;

  const children = (node.children || []).slice(0, maxChildren);

  if (depth >= MAX_DEPTH - 1 || children.length === 0) {
    return { topic: node.topic };
  }

  return {
    topic: node.topic,
    children: children.map((child) => clampMindmapTree(child, depth + 1)),
  };
};

const normalizeMindmapNode = (node: any): MindmapNode | null => {
  if (!node || typeof node !== "object" || typeof node.topic !== "string") {
    return null;
  }

  const children: MindmapNode[] = Array.isArray(node.children)
    ? node.children
        .map((child: any) => normalizeMindmapNode(child))
        .filter((child: MindmapNode | null): child is MindmapNode => !!child)
    : [];

  return {
    topic: node.topic,
    children,
  };
};

const getLeafCount = (node: MindmapNode): number => {
  if (!node.children || node.children.length === 0) {
    return 1;
  }

  return node.children.reduce((sum, child) => sum + getLeafCount(child), 0);
};

const layoutMindmap = (root: MindmapNode) => {
  type PositionedNode = MindmapNode & { x: number; y: number; depth: number };

  const H_GAP = 260;
  const V_GAP = 110;

  const positioned: PositionedNode[] = [];
  const edges: { from: number; to: number }[] = [];

  const layoutSubtree = (
    node: MindmapNode,
    side: "left" | "right",
    parentIndex: number,
    x: number,
    centerY: number,
    depth: number,
  ) => {
    const current: PositionedNode = { ...node, x, y: centerY, depth };
    const currentIndex = positioned.length;
    positioned.push(current);
    edges.push({ from: parentIndex, to: currentIndex });

    if (!node.children || node.children.length === 0) {
      return;
    }

    const children = node.children;
    const totalLeaf = children.reduce(
      (sum, child) => sum + getLeafCount(child),
      0,
    );

    // 将当前节点的子树高度按叶子数量均匀分配给各子节点
    let currentTop = centerY - ((totalLeaf * V_GAP - V_GAP) / 2);

    children.forEach((child) => {
      const leafCount = getLeafCount(child);
      const subtreeHeight = leafCount * V_GAP;
      const childCenterY = currentTop + (subtreeHeight - V_GAP) / 2;

      layoutSubtree(
        child,
        side,
        currentIndex,
        x + (side === "right" ? H_GAP : -H_GAP),
        childCenterY,
        depth + 1,
      );

      currentTop += subtreeHeight;
    });
  };

  const layoutSide = (
    nodes: MindmapNode[],
    side: "left" | "right",
    parentIndex: number,
    parentX: number,
    parentY: number,
    parentDepth: number,
  ) => {
    if (!nodes.length) {
      return;
    }

    const totalLeaf = nodes.reduce(
      (sum, node) => sum + getLeafCount(node),
      0,
    );

    let currentTop = parentY - ((totalLeaf * V_GAP - V_GAP) / 2);

    nodes.forEach((node) => {
      const leafCount = getLeafCount(node);
      const subtreeHeight = leafCount * V_GAP;
      const centerY = currentTop + (subtreeHeight - V_GAP) / 2;

      layoutSubtree(
        node,
        side,
        parentIndex,
        parentX + (side === "right" ? H_GAP : -H_GAP),
        centerY,
        parentDepth + 1,
      );

      currentTop += subtreeHeight;
    });
  };

  const rootX = 0;
  const rootY = 0;
  const rootPositioned: PositionedNode = { ...root, x: rootX, y: rootY, depth: 0 };
  const rootIndex = positioned.length;
  positioned.push(rootPositioned);

  const children = root.children || [];
  const half = Math.ceil(children.length / 2);
  const leftChildren = children.slice(0, half);
  const rightChildren = children.slice(half);

  layoutSide(leftChildren, "left", rootIndex, rootX, rootY, 0);
  layoutSide(rightChildren, "right", rootIndex, rootX, rootY, 0);

  return { positioned, edges };
};

type MindmapThemeId = "default" | "warm" | "cool";

const buildMindmapElements = (root: MindmapNode, themeId: MindmapThemeId) => {
  const { positioned, edges } = layoutMindmap(root);

  const elements: NonDeletedExcalidrawElement[] = [];
  const nodeRects: NonDeletedExcalidrawElement[] = [];

  const getNodeStyleByDepth = (depth: number) => {
    if (themeId === "warm") {
      if (depth === 0) {
        return {
          strokeColor: "#7C2D12", // orange-900
          backgroundColor: "#FFEDD5", // orange-100
          strokeWidth: 2,
        };
      }
      if (depth === 1) {
        return {
          strokeColor: "#9A3412", // orange-800
          backgroundColor: "#FED7AA", // orange-200
          strokeWidth: 2,
        };
      }
      return {
        strokeColor: "#92400E", // orange-700
        backgroundColor: "#FFFBEB", // amber-50
        strokeWidth: 1.5,
      };
    }

    if (themeId === "cool") {
      if (depth === 0) {
        return {
          strokeColor: "#0F766E", // teal-700
          backgroundColor: "#CCFBF1", // teal-100
          strokeWidth: 2,
        };
      }
      if (depth === 1) {
        return {
          strokeColor: "#0369A1", // sky-700
          backgroundColor: "#E0F2FE", // sky-100
          strokeWidth: 2,
        };
      }
      return {
        strokeColor: "#475569", // slate-600
        backgroundColor: "#F8FAFC", // slate-50
        strokeWidth: 1.5,
      };
    }

    // default 主题
    if (depth === 0) {
      return {
        strokeColor: "#111827", // gray-900
        backgroundColor: "#E5E7EB", // gray-200
        strokeWidth: 2,
      };
    }
    if (depth === 1) {
      return {
        strokeColor: "#1D4ED8", // blue-700
        backgroundColor: "#EFF6FF", // blue-50
        strokeWidth: 2,
      };
    }
    return {
      strokeColor: "#4B5563", // gray-600
      backgroundColor: "#F9FAFB", // gray-50
      strokeWidth: 1.5,
    };
  };

  const createNodeElements = (node: {
    topic: string;
    x: number;
    y: number;
    depth: number;
  }) => {
    const nodeGroupId = randomId();
    const { strokeColor, backgroundColor, strokeWidth } = getNodeStyleByDepth(
      node.depth,
    );

    const textElement = newTextElement({
      x: node.x,
      y: node.y,
      text: node.topic,
      textAlign: "center",
      verticalAlign: "middle",
      strokeColor,
      groupIds: [nodeGroupId],
    });

    const paddingX = 24;
    const paddingY = 16;

    const rectElement = newElement({
      type: "rectangle",
      x: textElement.x - paddingX / 2,
      y: textElement.y - paddingY / 2,
      width: textElement.width + paddingX,
      height: textElement.height + paddingY,
      strokeColor,
      backgroundColor,
      strokeWidth,
      groupIds: [nodeGroupId],
    });

    elements.push(rectElement as NonDeletedExcalidrawElement);
    elements.push(textElement as NonDeletedExcalidrawElement);

    return rectElement as NonDeletedExcalidrawElement;
  };

  positioned.forEach((node, index) => {
    const rectElement = createNodeElements(node as any);
    nodeRects[index] = rectElement;
  });

  const getRectEdgeAnchor = (
    element: NonDeletedExcalidrawElement,
    targetCenterX: number,
    targetCenterY: number,
  ) => {
    const centerX = element.x + element.width / 2;
    const centerY = element.y + element.height / 2;

    const dx = targetCenterX - centerX;
    const dy = targetCenterY - centerY;

    if (dx === 0 && dy === 0) {
      return { x: centerX, y: centerY };
    }

    const halfWidth = Math.abs(element.width) / 2;
    const halfHeight = Math.abs(element.height) / 2;

    const tx = dx !== 0 ? halfWidth / Math.abs(dx) : Number.POSITIVE_INFINITY;
    const ty = dy !== 0 ? halfHeight / Math.abs(dy) : Number.POSITIVE_INFINITY;

    const t = Math.min(tx, ty);

    return {
      x: centerX + dx * t,
      y: centerY + dy * t,
    };
  };

  const lineBindings: {
    line: NonDeletedExcalidrawElement;
    from: NonDeletedExcalidrawElement;
    to: NonDeletedExcalidrawElement;
  }[] = [];

  edges.forEach(({ from, to }) => {
    const parentRect = nodeRects[from];
    const childRect = nodeRects[to];

    if (!parentRect || !childRect) {
      return;
    }

    const parentCenterX = parentRect.x + parentRect.width / 2;
    const parentCenterY = parentRect.y + parentRect.height / 2;
    const childCenterX = childRect.x + childRect.width / 2;
    const childCenterY = childRect.y + childRect.height / 2;

    const parentAnchor = getRectEdgeAnchor(
      parentRect,
      childCenterX,
      childCenterY,
    );
    const childAnchor = getRectEdgeAnchor(
      childRect,
      parentCenterX,
      parentCenterY,
    );

    const dx = childAnchor.x - parentAnchor.x;
    const dy = childAnchor.y - parentAnchor.y;

    const arrow = newArrowElement({
      type: "arrow",
      x: parentAnchor.x,
      y: parentAnchor.y,
      width: dx,
      height: dy,
      points: [pointFrom(0, 0), pointFrom(dx, dy)],
      endArrowhead: "arrow",
      // 使用与 Text-to-Diagram 曲箭头一致的圆角类型
      roundness: { type: ROUNDNESS.PROPORTIONAL_RADIUS },
      // 稍微加粗一点，避免在复杂思维导图中太细
      strokeWidth: 2,
    });

    elements.push(arrow as NonDeletedExcalidrawElement);

    lineBindings.push({
      line: arrow as NonDeletedExcalidrawElement,
      from: parentRect,
      to: childRect,
    });
  });

  // 创建临时 Scene，用于调用 bindLinearElement 将线绑定到矩形上
  const elementsMap = new Map<string, NonDeletedExcalidrawElement>();
  elements.forEach((element) => {
    elementsMap.set(element.id, element);
  });

  const scene = new Scene(elementsMap as any);

  lineBindings.forEach(({ line, from, to }) => {
    bindLinearElement(line as any, from as any, "start", scene);
    bindLinearElement(line as any, to as any, "end", scene);
  });

  return {
    elements,
    files: null as BinaryFiles | null,
  };
};

export const renderMindmapPreviewFromTreeJson = async ({
  canvasRef,
  setError,
  data,
  treeJson,
  themeId = "default",
}: {
  canvasRef: React.RefObject<HTMLDivElement | null>;
  setError: (error: Error | null) => void;
  data: React.MutableRefObject<{
    elements: readonly NonDeletedExcalidrawElement[];
    files: BinaryFiles | null;
  }>;
  treeJson: string;
  themeId?: MindmapThemeId;
}) => {
  const canvasNode = canvasRef.current;
  const parent = canvasNode?.parentElement;

  if (!canvasNode || !parent) {
    return;
  }

  if (!treeJson) {
    resetPreview({ canvasRef, setError });
    return;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(treeJson);
  } catch (e: any) {
    throw new Error("Invalid mindmap data (JSON parse failed)");
  }

  const normalized = normalizeMindmapNode(parsed);
  if (!normalized) {
    throw new Error("Invalid mindmap data (missing topic)");
  }

  const clamped = clampMindmapTree(normalized);

  try {
    const { elements, files } = buildMindmapElements(
      clamped,
      themeId as MindmapThemeId,
    );

    data.current = {
      elements,
      files,
    };

    const canvas = await exportToCanvas({
      elements: data.current.elements,
      files: data.current.files,
      exportPadding: DEFAULT_EXPORT_PADDING,
      maxWidthOrHeight:
        Math.max(parent.offsetWidth, parent.offsetHeight) *
        window.devicePixelRatio,
    });

    try {
      await canvasToBlob(canvas);
    } catch (e: any) {
      if (e.name === "CANVAS_POSSIBLY_TOO_BIG") {
        throw new Error(t("canvasError.canvasTooBig"));
      }
      throw e;
    }

    parent.style.background = "var(--default-bg-color)";
    canvasNode.replaceChildren(canvas);
    setError(null);
  } catch (err: any) {
    parent.style.background = "var(--default-bg-color)";
    setError(err);
    throw err;
  }
};

export const saveMermaidDataToStorage = (mermaidDefinition: string) => {
  EditorLocalStorage.set(
    EDITOR_LS_KEYS.MERMAID_TO_EXCALIDRAW,
    mermaidDefinition,
  );
};

export const insertToEditor = ({
  app,
  data,
  text,
  shouldSaveMermaidDataToStorage,
}: {
  app: AppClassProperties;
  data: React.MutableRefObject<{
    elements: readonly NonDeletedExcalidrawElement[];
    files: BinaryFiles | null;
  }>;
  text?: string;
  shouldSaveMermaidDataToStorage?: boolean;
}) => {
  const { elements: newElements, files } = data.current;

  if (!newElements.length) {
    return;
  }

  app.addElementsFromPasteOrLibrary({
    elements: newElements,
    files,
    position: "center",
    fitToContent: true,
  });
  app.setOpenDialog(null);

  if (shouldSaveMermaidDataToStorage && text) {
    saveMermaidDataToStorage(text);
  }
};
