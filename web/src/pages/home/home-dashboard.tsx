import { ArrowRight, Plus, RefreshCw } from "lucide-react";
import { Link, useNavigate } from "react-router";
import type { CanvasLibrarySummary } from "@/services/api/workspace-data";
import { ProjectPreview } from "@/components/canvas/canvas-project-card";
import { HovAITVCapabilityItems } from "./home-data";
import { useAppearanceStore } from "@/stores/use-appearance-store";
function formatDate(value: string) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "刚刚更新";
    return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date).replaceAll("/", "-");
}

export function HomeDashboard({ projects, loading, error, onRetry }: { projects: CanvasLibrarySummary[]; loading: boolean; error: boolean; onRetry: () => void }) {
    const navigate = useNavigate();
    const brandName = useAppearanceStore((state) => state.appearance.brandName);
    return (
        <main className="hovaitv-home" aria-label={`${brandName} 首页`}>
            <section className="hovaitv-home-hero" aria-label="新建画布">
                <span className="hovaitv-home-dot-base" aria-hidden />
                <span className="hovaitv-home-dot-flow" aria-hidden />
                <span className="hovaitv-home-dot-flow hovaitv-home-dot-flow-delay" aria-hidden />
                <button type="button" className="hovaitv-home-create" onClick={() => navigate("/canvas?mode=new")}>
                    <span className="hovaitv-home-create-icon"><Plus /></span>
                    <span className="hovaitv-home-create-title">新建画布创作</span>
                </button>
            </section>

            <nav className="hovaitv-capabilities" aria-label="创作能力">
                {HovAITVCapabilityItems.map(({ id, label, detail, to, icon: Icon, disabled }) => (
                    disabled ? (
                        <span key={id} className="hovaitv-capability is-disabled" aria-disabled="true" title={`${label}：${detail}`}>
                            <span className="hovaitv-capability-icon"><Icon /></span>
                            <strong>{label}</strong>
                        </span>
                    ) : (
                        <Link key={id} to={to} className="hovaitv-capability">
                            <span className="hovaitv-capability-icon"><Icon /></span>
                            <strong>{label}</strong>
                        </Link>
                    )
                ))}
            </nav>

            <section className="hovaitv-home-section hovaitv-recents">
                <header className="hovaitv-section-heading"><h2>最近项目</h2><Link to="/project">查看全部 <ArrowRight /></Link></header>
                {error ? (
                    <button className="hovaitv-home-error" type="button" onClick={onRetry}><RefreshCw />画布读取失败，点击重试</button>
                ) : (
                    <div className="hovaitv-recent-grid">
                        {loading ? Array.from({ length: 4 }, (_, index) => <div className="hovaitv-recent-card is-loading" key={index} />) : projects.length ? projects.map((project) => {
                            return <Link to={`/canvas/${project.id}`} className="hovaitv-recent-card" key={project.id}>
                                <span className="hovaitv-recent-preview"><ProjectPreview project={{ id: project.id, nodes: project.previewNodes }} emptyVariant="libtv" /></span>
                                <span className="hovaitv-recent-copy"><strong>{project.title || "未命名"}</strong><small>{formatDate(project.updatedAt)}</small></span>
                                <ArrowRight className="hovaitv-recent-arrow" />
                            </Link>;
                        }) : <button type="button" className="hovaitv-recent-card is-empty" onClick={() => navigate("/canvas?mode=new")}><span className="hovaitv-recent-preview"><Plus /></span><span className="hovaitv-recent-copy"><strong>创建第一个画布</strong><small>让灵感有一个开始的地方</small></span></button>}
                    </div>
                )}
            </section>
        </main>
    );
}
