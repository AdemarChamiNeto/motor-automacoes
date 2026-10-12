import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { CATALOG, isTrigger, OPERATORS } from "./catalog";
import type { RFNode } from "./convert";
import { Icon, NODE_ICON } from "../ui/icons";

/** Resumo de uma linha da configuração, para entender o fluxo sem abrir cada nó. */
export function summary(type: string, c: Record<string, unknown>): string {
  switch (type) {
    case "trigger.schedule": return `cron ${String(c.cron ?? "")}`;
    case "trigger.webhook": return "POST na URL do fluxo";
    case "trigger.manual": return "botão Executar agora";
    case "condition": {
      const op = OPERATORS.find((o) => o.value === c.operator);
      return `${String(c.left ?? "")} ${op?.label ?? ""}${op?.unary ? "" : ` ${String(c.right ?? "")}`}`;
    }
    case "http": return `${String(c.method ?? "GET")} ${String(c.url ?? "")}`;
    default: return String(c.message ?? "") || "(sem mensagem)";
  }
}

/** Nó do canvas. A condição tem duas saídas (sim / não); o gatilho não tem entrada. */
function MotorNodeView({ data, selected }: NodeProps<RFNode>) {
  const spec = CATALOG[data.type];
  const trigger = isTrigger(data.type);
  const cls = [
    "mnode", `g-${spec?.group ?? "action"}`, selected && "selected",
    data.problems?.length && "has-problem", data.stepStatus && `step-${data.stepStatus}`,
  ].filter(Boolean).join(" ");
  return (
    <div className={cls} title={data.problems?.join("\n")}>
      {!trigger && <Handle type="target" position={Position.Left} />}
      <div className="mnode-head">
        <span className="mnode-icon"><Icon name={NODE_ICON[data.type]} size={16} /></span>
        <span className="mnode-label">{trigger ? `Gatilho: ${spec.label}` : spec.label}</span>
      </div>
      <div className="mnode-sub">{summary(data.type, data.config)}</div>
      {data.problems?.length ? <div className="mnode-problem">{data.problems[0]}</div> : null}
      {data.type === "condition" ? (
        <>
          <Handle type="source" id="true" position={Position.Right} style={{ top: "35%" }} className="h-true" />
          <Handle type="source" id="false" position={Position.Right} style={{ top: "75%" }} className="h-false" />
          <span className="mnode-out t">sim</span>
          <span className="mnode-out f">não</span>
        </>
      ) : (
        <Handle type="source" position={Position.Right} />
      )}
    </div>
  );
}

export const MotorNode = memo(MotorNodeView);
export const nodeTypes = { motor: MotorNode };
