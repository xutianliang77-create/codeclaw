/**
 * d3-force directed graph 渲染（B.7）
 *
 * - SVG + react 控制；不引完整 react-force-graph 包（保持 bundle 小）
 * - 支持节点拖动 / 缩放 / 平移 / hover 高亮
 * - 节点 ≤ 500 流畅；超 500 提示精化 query
 *
 * Spec：doc/specs/web-ui-roadmap.md §3.3
 */

import { useEffect, useMemo, useRef, useState } from "react";
import * as d3Force from "d3-force";
import * as d3Selection from "d3-selection";
import * as d3Zoom from "d3-zoom";
import * as d3Drag from "d3-drag";

export interface ForceNode {
  id: string;
  group: "file" | "symbol" | "external";
  // d3-force 会注入 x/y/vx/vy/fx/fy
  x?: number;
  y?: number;
  fx?: number | null;
  fy?: number | null;
}

export interface ForceLink {
  source: string | ForceNode;
  target: string | ForceNode;
  kind: "calls" | "imports" | "declares";
}

interface Props {
  nodes: ForceNode[];
  links: ForceLink[];
  onNodeClick?(node: ForceNode): void;
  onNodeDoubleClick?(node: ForceNode): void;
  height?: number;
}

const NODE_LIMIT_WARN = 500;
const COLORS: Record<ForceNode["group"], string> = {
  file: "#4a9cff",
  symbol: "#2da94f",
  external: "#999999",
};

export default function GraphForce({
  nodes,
  links,
  onNodeClick,
  onNodeDoubleClick,
  height = 560,
}: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const overflow = nodes.length > NODE_LIMIT_WARN;

  // 深拷贝避免 d3 mutate 父组件传入对象
  const data = useMemo(
    () => ({
      nodes: nodes.map((n) => ({ ...n })),
      links: links.map((l) => ({ ...l })),
    }),
    [nodes, links]
  );

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const width = svg.clientWidth || 800;

    // 清空旧 dom
    svg.innerHTML = "";
    const root = d3Selection.select(svg);
    const container = root.append("g");

    // 缩放 / 平移
    root.call(
      d3Zoom
        .zoom<SVGSVGElement, unknown>()
        .scaleExtent([0.2, 4])
        .on("zoom", (ev) => {
          container.attr("transform", ev.transform.toString());
        })
    );

    const sim = d3Force
      .forceSimulation<ForceNode>(data.nodes)
      .force(
        "link",
        d3Force
          .forceLink<ForceNode, ForceLink>(data.links)
          .id((d) => d.id)
          .distance(60)
      )
      .force("charge", d3Force.forceManyBody<ForceNode>().strength(-160))
      .force("center", d3Force.forceCenter(width / 2, height / 2))
      .force("collide", d3Force.forceCollide<ForceNode>(18));

    const linkSel = container
      .append("g")
      .attr("stroke", "#888")
      .attr("stroke-opacity", 0.4)
      .selectAll("line")
      .data(data.links)
      .enter()
      .append("line")
      .attr("stroke-width", 1)
      .attr("stroke-dasharray", (d) => (d.kind === "imports" ? "3,3" : null));

    const nodeGroup = container
      .append("g")
      .selectAll("g")
      .data(data.nodes)
      .enter()
      .append("g")
      .style("cursor", "pointer")
      .call(
        d3Drag
          .drag<SVGGElement, ForceNode>()
          .on("start", (ev, d) => {
            if (!ev.active) sim.alphaTarget(0.3).restart();
            d.fx = d.x ?? 0;
            d.fy = d.y ?? 0;
          })
          .on("drag", (ev, d) => {
            d.fx = ev.x;
            d.fy = ev.y;
          })
          .on("end", (ev, d) => {
            if (!ev.active) sim.alphaTarget(0);
            d.fx = null;
            d.fy = null;
          })
      )
      .on("click", (_ev, d) => onNodeClick?.(d))
      .on("dblclick", (_ev, d) => onNodeDoubleClick?.(d))
      .on("mouseenter", (_ev, d) => setHover(d.id))
      .on("mouseleave", () => setHover(null));

    nodeGroup
      .append("circle")
      .attr("r", 7)
      .attr("fill", (d) => COLORS[d.group])
      .attr("stroke", "#fff")
      .attr("stroke-width", 1);

    nodeGroup
      .append("text")
      .attr("dx", 10)
      .attr("dy", 4)
      .style("font-size", "11px")
      .style("font-family", "ui-monospace, monospace")
      .style("fill", "#666")
      .text((d) => {
        // 文件路径取末段；symbol 名直接显示
        if (d.group === "file") return d.id.split("/").pop() ?? d.id;
        return d.id;
      });

    sim.on("tick", () => {
      linkSel
        .attr("x1", (d) => (d.source as ForceNode).x ?? 0)
        .attr("y1", (d) => (d.source as ForceNode).y ?? 0)
        .attr("x2", (d) => (d.target as ForceNode).x ?? 0)
        .attr("y2", (d) => (d.target as ForceNode).y ?? 0);
      nodeGroup.attr("transform", (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);
    });

    return () => {
      sim.stop();
    };
  }, [data, height, onNodeClick, onNodeDoubleClick]);

  return (
    <div className="border border-border rounded relative">
      {overflow && (
        <div className="absolute top-2 right-2 bg-danger/10 text-danger px-2 py-1 text-xs rounded border border-danger/30 z-10">
          {nodes.length} 节点，&gt;{NODE_LIMIT_WARN} 可能卡顿；建议精化查询
        </div>
      )}
      {hover && (
        <div className="absolute bottom-2 left-2 bg-bg/95 px-2 py-1 text-xs font-mono rounded border border-border z-10">
          {hover}
        </div>
      )}
      <svg
        ref={svgRef}
        width="100%"
        height={height}
        className="block"
      />
    </div>
  );
}
