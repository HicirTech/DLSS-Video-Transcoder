/** The app shell: the top bar and the tabbed panels, with the selected tab remembered in localStorage. */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AppBar, Box, Chip, Container, Tab, Tabs, Toolbar, Typography } from "@mui/material";
import MemoryIcon from "@mui/icons-material/Memory";
import type { ProbeReport, ToolsReport } from "../../src/server/api-types";
import { api, isMockMode, useJobsFeed } from "./api";
import { errorMessage } from "./errors";
import { isJobActive } from "./format";
import { useNow } from "./hooks/useNow";
import { SettingsProvider } from "./hooks/useSettings";
import { ToastProvider, useToast } from "./hooks/useToast";
import { ImagePanel } from "./components/ImagePanel";
import { JobsPanel } from "./components/JobsPanel";
import { ProbePanel } from "./components/ProbePanel";
import { ReadyChip } from "./components/ReadyChip";
import { SettingsPanel } from "./components/SettingsPanel";
import { VideoPanel } from "./components/VideoPanel";

const TAB_KEY = "neural-render.tab";
/** The tabs in display order; the stored tab is an index into this list. */
const TABS = ["probe", "image", "video", "jobs", "settings"] as const;
type TabId = (typeof TABS)[number];

function tabIndex(id: TabId): number {
  return TABS.indexOf(id);
}

function readTab(): number {
  try {
    const value = Number(localStorage.getItem(TAB_KEY));
    return Number.isInteger(value) && value >= 0 && value < TABS.length ? value : 0;
  } catch {
    return 0;
  }
}

function storeTab(value: number): void {
  try {
    localStorage.setItem(TAB_KEY, String(value));
  } catch {
    // ignore: the tab choice is only a convenience
  }
}

/**
 * Every tab stays mounted so form state survives switching; inactive ones are hidden. Two panels can
 * therefore render the same component at once, so an element id comes from useId, never a constant:
 * a fixed id would appear twice in one document.
 */
function TabPanel({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <Box role="tabpanel" hidden={!active} sx={{ display: active ? "block" : "none" }}>
      {children}
    </Box>
  );
}

function Shell() {
  const toast = useToast();
  const feed = useJobsFeed();
  const tabsId = useId();
  const [tab, setTab] = useState(readTab);
  const [probe, setProbe] = useState<ProbeReport | null>(null);
  const [probing, setProbing] = useState(false);
  const [tools, setTools] = useState<ToolsReport | null>(null);
  const [toolsError, setToolsError] = useState<string | null>(null);

  const activeJobs = feed.jobs.filter(isJobActive).length;
  const now = useNow(activeJobs > 0);

  const runProbe = useCallback(async (): Promise<void> => {
    setProbing(true);
    try {
      setProbe(await api.probe());
    } catch (err) {
      toast.showError(`Probe failed: ${errorMessage(err)}`);
    } finally {
      setProbing(false);
    }
  }, [toast]);

  useEffect(() => {
    let active = true;
    api
      .tools()
      .then((report) => {
        if (active) setTools(report);
      })
      .catch((err: unknown) => {
        if (active) setToolsError(errorMessage(err));
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (feed.error) toast.showError(`Could not load the job list: ${feed.error}`);
  }, [feed.error, toast]);

  const selectTab = (value: number): void => {
    setTab(value);
    storeTab(value);
  };

  /** What ties a tab to its panel: the index Tabs selects by, and the ids each names the other with. */
  const tabProps = (id: TabId) => ({ value: tabIndex(id), id: `${tabsId}-tab-${id}`, "aria-controls": `${tabsId}-panel-${id}` });
  const panelProps = (id: TabId) => ({ active: tab === tabIndex(id), id: `${tabsId}-panel-${id}`, labelledBy: `${tabsId}-tab-${id}` });

  return (
    <Box sx={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <AppBar position="sticky" color="default" elevation={0} sx={{ borderBottom: 1, borderColor: "divider" }}>
        <Toolbar variant="dense" sx={{ gap: 1.5 }}>
          <MemoryIcon color="primary" />
          <Typography variant="h6" component="h1" sx={{ fontWeight: 700, letterSpacing: 0.3 }}>
            Neural Render
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: { xs: "none", md: "block" } }}>
            DLSS neural rendering for images and video, run locally on your GPU
          </Typography>
          <Box sx={{ flex: 1 }} />
          {isMockMode() ? <Chip label="mock data" color="warning" variant="outlined" /> : null}
          <Chip
            label={feed.connected ? "live" : "offline"}
            color={feed.connected ? "success" : "default"}
            variant="outlined"
          />
          <ReadyChip probe={probe} probing={probing} onProbe={() => void runProbe()} />
        </Toolbar>
        <Tabs value={tab} onChange={(_event, value: number) => selectTab(value)} sx={{ px: 1 }}>
          <Tab label="Probe" {...tabProps("probe")} />
          <Tab label="Image" {...tabProps("image")} />
          <Tab label="Video" {...tabProps("video")} />
          <Tab label={activeJobs > 0 ? `Jobs (${activeJobs})` : "Jobs"} {...tabProps("jobs")} />
          <Tab label="Settings" {...tabProps("settings")} />
        </Tabs>
      </AppBar>

      <Container maxWidth="xl" sx={{ py: 3, flex: 1 }}>
        <TabPanel active={tab === 0}>
          <ProbePanel probe={probe} probing={probing} onProbe={() => void runProbe()} />
        </TabPanel>
        <TabPanel {...panelProps("image")}>
          <ImagePanel jobs={feed.jobs} now={now} />
        </TabPanel>
        <TabPanel {...panelProps("video")}>
          <VideoPanel jobs={feed.jobs} now={now} tools={tools} toolsError={toolsError} />
        </TabPanel>
        <TabPanel active={tab === 3}>
          <JobsPanel jobs={feed.jobs} now={now} connected={feed.connected} onRefresh={() => void feed.refresh()} />
        </TabPanel>
        <TabPanel {...panelProps("settings")}>
          <SettingsPanel probe={probe} probing={probing} onProbe={() => void runProbe()} />
        </TabPanel>
      </Container>
    </Box>
  );
}

export default function App() {
  return (
    <SettingsProvider>
      <ToastProvider>
        <Shell />
      </ToastProvider>
    </SettingsProvider>
  );
}
