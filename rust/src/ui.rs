use super::*;
use ratatui::{
    backend::CrosstermBackend,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, List, ListItem, ListState, Paragraph, Wrap},
    Frame, Terminal,
};
use std::time::Instant;

const NARROW_BREAKPOINT: u16 = 84;
const RELOAD_THROTTLE: Duration = Duration::from_millis(500);
const SLOW_FRAME_THRESHOLD: Duration = Duration::from_millis(100);
const SLOW_FRAME_LOG_INTERVAL: Duration = Duration::from_secs(60);

/// Tracks view-model reload throttling. Pure logic (no I/O) so the decision
/// can be unit-tested headlessly.
struct ReloadThrottle {
    interval: Duration,
    last_reload: Option<Instant>,
    force: bool,
}

impl ReloadThrottle {
    fn new(interval: Duration) -> Self {
        Self {
            interval,
            last_reload: None,
            force: true,
        }
    }

    fn force_reload(&mut self) {
        self.force = true;
    }

    fn should_reload(&self, now: Instant) -> bool {
        self.force
            || self
                .last_reload
                .map_or(true, |last| now.duration_since(last) >= self.interval)
    }

    fn mark_reloaded(&mut self, now: Instant) {
        self.last_reload = Some(now);
        self.force = false;
    }
}

/// Decide whether a slow frame warrants a debug ledger entry. Pure so it can
/// be tested without touching the real debug ledger or wall-clock timers.
fn should_log_slow_frame(
    cycle_duration: Duration,
    threshold: Duration,
    since_last_log: Duration,
    min_interval: Duration,
) -> bool {
    cycle_duration >= threshold && since_last_log >= min_interval
}

fn split_appliance_mode() -> bool {
    env::var("ARC_SPLIT_APPLIANCE")
        .map(|value| value != "0" && value != "off")
        .unwrap_or(false)
}

pub(crate) fn run_tab(args: &[String], workspace: &Path) -> Result<()> {
    if has_json(args) {
        return write_json(&load_ui_view_model(workspace, UiOptions::default())?);
    }
    if args.first().map(String::as_str) == Some("--frame") {
        let model = load_ui_view_model(workspace, UiOptions::default())?;
        println!("{}", render_ui_text(&model));
        return Ok(());
    }
    Err(anyhow!(
        "Usage: arc tab --json | arc tab --frame [--width N] [--height N]"
    ))
}

pub(crate) fn run_ui(args: &[String], workspace: &Path) -> Result<()> {
    for arg in args {
        if arg != "--once" {
            return Err(anyhow!("Unknown arc ui option: {arg}"));
        }
    }
    let model = load_ui_view_model(workspace, UiOptions::default())?;
    if args.iter().any(|arg| arg == "--once") {
        println!("{}", render_ui_text(&model));
        return Ok(());
    }
    if !io::stdout().is_terminal() && !split_appliance_mode() {
        println!("{}", render_status_summary(&model));
        return Ok(());
    }
    run_interactive_ui(workspace)
}

fn run_interactive_ui(workspace: &Path) -> Result<()> {
    use crossterm::event::{DisableMouseCapture, EnableMouseCapture};
    use crossterm::execute;
    use crossterm::terminal::{
        disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
    };

    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen, EnableMouseCapture)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;
    let result = run_ui_loop(workspace, &mut terminal);
    disable_raw_mode()?;
    execute!(
        terminal.backend_mut(),
        DisableMouseCapture,
        LeaveAlternateScreen
    )?;
    result
}

fn run_ui_loop(
    workspace: &Path,
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
) -> Result<()> {
    use crossterm::event::{self, Event, KeyCode, MouseButton, MouseEventKind};

    let mut state = InteractiveUiState::default();
    let mut hit_regions = Vec::new();
    let mut last_area = Rect::default();
    let mut throttle = ReloadThrottle::new(RELOAD_THROTTLE);
    let mut last_slow_frame_log = Instant::now()
        .checked_sub(SLOW_FRAME_LOG_INTERVAL)
        .unwrap_or_else(Instant::now);

    // Initial load — model is cached and only reloaded on the throttle.
    let mut model = {
        let options = UiOptions {
            query: state.filter.clone(),
            selected_id: None,
            event_limit: Some(160),
        };
        load_ui_view_model(workspace, options)?
    };
    throttle.mark_reloaded(Instant::now());

    loop {
        let cycle_start = Instant::now();

        // Throttled reload: at most once per RELOAD_THROTTLE, or immediately
        // after a mutating action flagged via throttle.force_reload().
        if throttle.should_reload(cycle_start) {
            let options = UiOptions {
                query: state.filter.clone(),
                selected_id: None,
                event_limit: Some(160),
            };
            model = load_ui_view_model(workspace, options)?;
            throttle.mark_reloaded(Instant::now());
        }
        state.clamp(&model);
        if (state.tab == UiTab::Settings || state.narrow_screen == NarrowScreen::Judge)
            && state.judge_models.is_empty()
        {
            state.judge_models = load_judge_model_choices();
            state.sync_model_selection(model.status.judge.model.as_ref());
        }
        terminal.draw(|frame| {
            last_area = frame.area();
            hit_regions.clear();
            draw_ui_frame(frame, &model, &state, &mut hit_regions);
        })?;
        if !event::poll(Duration::from_millis(250))? {
            let elapsed = cycle_start.elapsed();
            if should_log_slow_frame(
                elapsed,
                SLOW_FRAME_THRESHOLD,
                cycle_start.duration_since(last_slow_frame_log),
                SLOW_FRAME_LOG_INTERVAL,
            ) {
                debug(
                    workspace,
                    "ui.slow_frame",
                    json!({ "elapsed_ms": elapsed.as_millis() as u64 }),
                )?;
                last_slow_frame_log = Instant::now();
            }
            continue;
        }

        // Coalesce: drain all pending events before redrawing. A mouse wheel
        // burst emits dozens of events; without coalescing each one triggers a
        // full disk reload + redraw, freezing the pane for 1–2 seconds.
        let mut should_close = false;
        loop {
            match event::read()? {
            Event::Key(key) => {
                if state.appliance || last_area.width < NARROW_BREAKPOINT {
                    match handle_narrow_key(key.code, &model, &mut state)? {
                        NarrowKeyOutcome::Close => {
                            should_close = true;
                            break;
                        }
                        NarrowKeyOutcome::Continue => {}
                        NarrowKeyOutcome::Action(action) => {
                            handle_ui_action(action, &model, &mut state, workspace, terminal)?;
                            throttle.force_reload();
                        }
                    }
                    continue;
                }
                if state.filter_editing {
                    match key.code {
                        KeyCode::Esc => state.filter_editing = false,
                        KeyCode::Enter => state.filter_editing = false,
                        KeyCode::Backspace => {
                            state.filter.pop();
                            state.selected_capsule = 0;
                            throttle.force_reload();
                        }
                        KeyCode::Char(value) => {
                            state.filter.push(value);
                            state.selected_capsule = 0;
                            throttle.force_reload();
                        }
                        _ => {}
                    }
                    continue;
                }
                match key.code {
                    KeyCode::Char('q') | KeyCode::Esc => {
                        should_close = true;
                        break;
                    }
                    KeyCode::Tab => state.next_tab(),
                    KeyCode::BackTab => state.previous_tab(),
                    KeyCode::Char('1') => state.tab = UiTab::Capsules,
                    KeyCode::Char('2') => state.tab = UiTab::Activity,
                    KeyCode::Char('3') | KeyCode::Char('s') => {
                        state.tab = UiTab::Settings;
                        state.judge_models = load_judge_model_choices();
                        state.sync_model_selection(model.status.judge.model.as_ref());
                    }
                    KeyCode::Char('4') | KeyCode::Char('d') => state.tab = UiTab::Declined,
                    KeyCode::Char('/') => {
                        state.tab = UiTab::Capsules;
                        state.filter_editing = true;
                        throttle.force_reload();
                    }
                    KeyCode::Char('r') => {
                        if state.tab == UiTab::Settings {
                            state.judge_models = load_judge_model_choices();
                            state.sync_model_selection(model.status.judge.model.as_ref());
                        }
                    }
                    KeyCode::Char('j') | KeyCode::Down => state.move_down(&model),
                    KeyCode::Char('k') | KeyCode::Up => state.move_up(),
                    KeyCode::Enter => {
                        if state.tab == UiTab::Settings {
                            apply_settings_selection(&mut state)?;
                            throttle.force_reload();
                        } else if state.tab == UiTab::Declined && !model.declined.is_empty() {
                            handle_ui_action(
                                UiAction::PromoteDeclined(state.selected_declined),
                                &model,
                                &mut state,
                                workspace,
                                terminal,
                            )?;
                            throttle.force_reload();
                        } else {
                            state.expanded = !state.expanded;
                        }
                    }
                    KeyCode::Left if state.tab == UiTab::Settings => {
                        adjust_settings_selection(&mut state, -1)?;
                        throttle.force_reload();
                    }
                    KeyCode::Right if state.tab == UiTab::Settings => {
                        adjust_settings_selection(&mut state, 1)?;
                        throttle.force_reload();
                    }
                    _ => {}
                }
            }
            Event::Mouse(mouse) => match mouse.kind {
                MouseEventKind::ScrollDown
                    if state.appliance || last_area.width < NARROW_BREAKPOINT =>
                {
                    state.narrow_scroll = state.narrow_scroll.saturating_add(3);
                }
                MouseEventKind::ScrollUp
                    if state.appliance || last_area.width < NARROW_BREAKPOINT =>
                {
                    state.narrow_scroll = state.narrow_scroll.saturating_sub(3);
                }
                MouseEventKind::ScrollDown => state.move_down(&model),
                MouseEventKind::ScrollUp => state.move_up(),
                MouseEventKind::Down(MouseButton::Left) => {
                    if let Some(action) = hit_regions
                        .iter()
                        .rev()
                        .find(|region| region.contains(mouse.column, mouse.row))
                        .map(|region| region.action.clone())
                    {
                        handle_ui_action(action, &model, &mut state, workspace, terminal)?;
                        throttle.force_reload();
                    } else if mouse.row <= 3 {
                        state.tab = if mouse.column > 43 {
                            UiTab::Declined
                        } else if mouse.column > 28 {
                            UiTab::Settings
                        } else if mouse.column > 13 {
                            UiTab::Activity
                        } else {
                            UiTab::Capsules
                        };
                    } else if state.tab == UiTab::Capsules && mouse.row > 6 {
                        state.selected_capsule = (mouse.row.saturating_sub(7) as usize / 4)
                            .min(model.capsules.len().saturating_sub(1));
                    } else if state.tab == UiTab::Activity && mouse.row > 6 {
                        state.selected_event = (mouse.row.saturating_sub(7) as usize / 2)
                            .min(model.recent_events.len().saturating_sub(1));
                    } else if state.tab == UiTab::Declined && mouse.row > 6 {
                        state.selected_declined = (mouse.row.saturating_sub(7) as usize / 4)
                            .min(model.declined.len().saturating_sub(1));
                    }
                }
                _ => {}
            },
            Event::Resize(_, _) => {}
            _ => {}
            }
            if should_close || !event::poll(Duration::from_millis(0))? {
                break;
            }
        }
        if should_close {
            break;
        }

        let elapsed = cycle_start.elapsed();
        if should_log_slow_frame(
            elapsed,
            SLOW_FRAME_THRESHOLD,
            cycle_start.duration_since(last_slow_frame_log),
            SLOW_FRAME_LOG_INTERVAL,
        ) {
            debug(
                workspace,
                "ui.slow_frame",
                json!({ "elapsed_ms": elapsed.as_millis() as u64 }),
            )?;
            last_slow_frame_log = Instant::now();
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UiTab {
    Capsules,
    Activity,
    Declined,
    Settings,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NarrowScreen {
    Summary,
    Capsules,
    CapsuleDetail,
    Activity,
    Declined,
    Judge,
    Injection,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum DetailSection {
    ReuseWhen,
    Steps,
    Commands,
    Evidence,
    DoNotReuseWhen,
    Validation,
    FailedAttempts,
}

#[derive(Debug, Clone)]
enum UiAction {
    OpenSummaryRow(usize),
    OpenCapsule(usize),
    Back,
    ToggleSection(DetailSection),
    ToggleSummary,
    ToggleZoom,
    CopySection(DetailSection),
    CopyCommand(usize),
    ShareCapsule,
    PromoteDeclined(usize),
    ToggleJudgeMode,
    SelectJudge(usize),
    SetInjection(InjectionChoice),
}

#[derive(Debug, Clone, Copy)]
enum InjectionChoice {
    Resume,
    OneHour,
    TwoHours,
    Today,
}

#[derive(Debug, Clone)]
struct HitRegion {
    area: Rect,
    action: UiAction,
}

impl HitRegion {
    fn contains(&self, column: u16, row: u16) -> bool {
        column >= self.area.x
            && column < self.area.x.saturating_add(self.area.width)
            && row >= self.area.y
            && row < self.area.y.saturating_add(self.area.height)
    }
}

#[derive(Debug, Clone)]
struct InteractiveUiState {
    appliance: bool,
    tab: UiTab,
    selected_capsule: usize,
    selected_declined: usize,
    selected_event: usize,
    expanded: bool,
    filter: String,
    filter_editing: bool,
    settings_row: usize,
    judge_models: Vec<JudgeModelChoice>,
    selected_judge_model: usize,
    narrow_screen: NarrowScreen,
    narrow_row: usize,
    narrow_scroll: u16,
    expanded_sections: HashSet<DetailSection>,
    summary_expanded: bool,
    notice: Option<String>,
}

impl Default for InteractiveUiState {
    fn default() -> Self {
        Self {
            appliance: split_appliance_mode(),
            tab: UiTab::Capsules,
            selected_capsule: 0,
            selected_declined: 0,
            selected_event: 0,
            expanded: true,
            filter: String::new(),
            filter_editing: false,
            settings_row: 0,
            judge_models: Vec::new(),
            selected_judge_model: 0,
            narrow_screen: NarrowScreen::Summary,
            narrow_row: 0,
            narrow_scroll: 0,
            expanded_sections: HashSet::new(),
            summary_expanded: false,
            notice: None,
        }
    }
}

impl InteractiveUiState {
    fn clamp(&mut self, model: &ArcUiViewModel) {
        self.selected_capsule = self
            .selected_capsule
            .min(model.capsules.len().saturating_sub(1));
        self.selected_event = self
            .selected_event
            .min(model.recent_events.len().saturating_sub(1));
        self.selected_declined = self
            .selected_declined
            .min(model.declined.len().saturating_sub(1));
        self.settings_row = self.settings_row.min(1);
        self.selected_judge_model = self
            .selected_judge_model
            .min(self.judge_models.len().saturating_sub(1));
    }

    fn next_tab(&mut self) {
        self.tab = match self.tab {
            UiTab::Capsules => UiTab::Declined,
            UiTab::Declined => UiTab::Activity,
            UiTab::Activity => UiTab::Settings,
            UiTab::Settings => UiTab::Capsules,
        };
    }

    fn previous_tab(&mut self) {
        self.tab = match self.tab {
            UiTab::Capsules => UiTab::Settings,
            UiTab::Declined => UiTab::Capsules,
            UiTab::Activity => UiTab::Declined,
            UiTab::Settings => UiTab::Activity,
        };
    }

    fn move_down(&mut self, model: &ArcUiViewModel) {
        match self.tab {
            UiTab::Capsules => {
                self.selected_capsule =
                    (self.selected_capsule + 1).min(model.capsules.len().saturating_sub(1));
            }
            UiTab::Activity => {
                self.selected_event =
                    (self.selected_event + 1).min(model.recent_events.len().saturating_sub(1));
            }
            UiTab::Declined => {
                self.selected_declined =
                    (self.selected_declined + 1).min(model.declined.len().saturating_sub(1));
            }
            UiTab::Settings => self.settings_row = (self.settings_row + 1).min(1),
        }
    }

    fn move_up(&mut self) {
        match self.tab {
            UiTab::Capsules => self.selected_capsule = self.selected_capsule.saturating_sub(1),
            UiTab::Activity => self.selected_event = self.selected_event.saturating_sub(1),
            UiTab::Declined => self.selected_declined = self.selected_declined.saturating_sub(1),
            UiTab::Settings => self.settings_row = self.settings_row.saturating_sub(1),
        }
    }

    fn sync_model_selection(&mut self, current: Option<&JudgeModel>) {
        if let Some(current) = current {
            if let Some(index) = self
                .judge_models
                .iter()
                .position(|choice| choice.provider == current.provider && choice.id == current.id)
            {
                self.selected_judge_model = index;
                return;
            }
            self.judge_models.push(JudgeModelChoice {
                provider: current.provider.clone(),
                id: current.id.clone(),
                name: current.id.clone(),
                cost_hint: None,
                size_hint: None,
            });
            self.selected_judge_model = self.judge_models.len().saturating_sub(1);
        }
    }
}

enum NarrowKeyOutcome {
    Close,
    Continue,
    Action(UiAction),
}

fn handle_narrow_key(
    code: crossterm::event::KeyCode,
    model: &ArcUiViewModel,
    state: &mut InteractiveUiState,
) -> Result<NarrowKeyOutcome> {
    use crossterm::event::KeyCode;
    match code {
        KeyCode::Char('q') if !state.appliance => return Ok(NarrowKeyOutcome::Close),
        KeyCode::Esc | KeyCode::Backspace | KeyCode::Left => {
            if state.narrow_screen == NarrowScreen::Summary {
                return Ok(if state.appliance {
                    NarrowKeyOutcome::Continue
                } else {
                    NarrowKeyOutcome::Close
                });
            }
            return Ok(NarrowKeyOutcome::Action(UiAction::Back));
        }
        KeyCode::Down | KeyCode::Char('j') => match state.narrow_screen {
            NarrowScreen::Summary => state.narrow_row = (state.narrow_row + 1).min(4),
            NarrowScreen::Capsules => {
                state.selected_capsule =
                    (state.selected_capsule + 1).min(model.capsules.len().saturating_sub(1));
                let selected_line = state.selected_capsule.saturating_mul(3) as u16;
                if selected_line > state.narrow_scroll.saturating_add(9) {
                    state.narrow_scroll = selected_line.saturating_sub(9);
                }
            }
            NarrowScreen::Activity => {
                state.selected_event =
                    (state.selected_event + 1).min(model.recent_events.len().saturating_sub(1));
                state.narrow_scroll = state.narrow_scroll.saturating_add(2);
            }
            NarrowScreen::Declined => {
                state.selected_declined =
                    (state.selected_declined + 1).min(model.declined.len().saturating_sub(1));
                let selected_line = state.selected_declined.saturating_mul(4) as u16;
                if selected_line > state.narrow_scroll.saturating_add(9) {
                    state.narrow_scroll = selected_line.saturating_sub(9);
                }
            }
            NarrowScreen::CapsuleDetail => {
                let last = model
                    .capsules
                    .get(state.selected_capsule)
                    .map(visible_detail_sections)
                    .map(|sections| sections.len().saturating_sub(1))
                    .unwrap_or(0);
                state.narrow_row = (state.narrow_row + 1).min(last);
            }
            NarrowScreen::Judge => {
                state.narrow_row = (state.narrow_row + 1).min(state.judge_models.len());
            }
            NarrowScreen::Injection => state.narrow_row = (state.narrow_row + 1).min(3),
        },
        KeyCode::Up | KeyCode::Char('k') => match state.narrow_screen {
            NarrowScreen::Summary => state.narrow_row = state.narrow_row.saturating_sub(1),
            NarrowScreen::Capsules => {
                state.selected_capsule = state.selected_capsule.saturating_sub(1);
                state.narrow_scroll = state
                    .narrow_scroll
                    .min(state.selected_capsule.saturating_mul(3) as u16);
            }
            NarrowScreen::Activity => {
                state.selected_event = state.selected_event.saturating_sub(1);
                state.narrow_scroll = state.narrow_scroll.saturating_sub(2);
            }
            NarrowScreen::Declined => {
                state.selected_declined = state.selected_declined.saturating_sub(1);
                state.narrow_scroll = state
                    .narrow_scroll
                    .min(state.selected_declined.saturating_mul(4) as u16);
            }
            NarrowScreen::CapsuleDetail | NarrowScreen::Judge | NarrowScreen::Injection => {
                state.narrow_row = state.narrow_row.saturating_sub(1);
            }
        },
        KeyCode::PageDown => state.narrow_scroll = state.narrow_scroll.saturating_add(8),
        KeyCode::PageUp => state.narrow_scroll = state.narrow_scroll.saturating_sub(8),
        KeyCode::Enter | KeyCode::Right => {
            let action = match state.narrow_screen {
                NarrowScreen::Summary => Some(UiAction::OpenSummaryRow(state.narrow_row)),
                NarrowScreen::Capsules if !model.capsules.is_empty() => {
                    Some(UiAction::OpenCapsule(state.selected_capsule))
                }
                NarrowScreen::Declined if !model.declined.is_empty() => {
                    Some(UiAction::PromoteDeclined(state.selected_declined))
                }
                NarrowScreen::CapsuleDetail => model
                    .capsules
                    .get(state.selected_capsule)
                    .and_then(|capsule| {
                        visible_detail_sections(capsule)
                            .get(state.narrow_row)
                            .copied()
                    })
                    .map(UiAction::ToggleSection),
                NarrowScreen::Judge if state.narrow_row == 0 => Some(UiAction::ToggleJudgeMode),
                NarrowScreen::Judge => {
                    Some(UiAction::SelectJudge(state.narrow_row.saturating_sub(1)))
                }
                NarrowScreen::Injection => Some(UiAction::SetInjection(match state.narrow_row {
                    0 => InjectionChoice::Resume,
                    1 => InjectionChoice::OneHour,
                    2 => InjectionChoice::TwoHours,
                    _ => InjectionChoice::Today,
                })),
                NarrowScreen::Activity => None,
                NarrowScreen::Declined => None,
                NarrowScreen::Capsules => None,
            };
            if let Some(action) = action {
                return Ok(NarrowKeyOutcome::Action(action));
            }
        }
        KeyCode::Char('c') if state.narrow_screen == NarrowScreen::CapsuleDetail => {
            if let Some(section) = model
                .capsules
                .get(state.selected_capsule)
                .and_then(|capsule| {
                    visible_detail_sections(capsule)
                        .get(state.narrow_row)
                        .copied()
                })
            {
                return Ok(NarrowKeyOutcome::Action(UiAction::CopySection(section)));
            }
        }
        KeyCode::Char('s') if state.narrow_screen == NarrowScreen::CapsuleDetail => {
            return Ok(NarrowKeyOutcome::Action(UiAction::ShareCapsule));
        }
        KeyCode::Char('f') if !state.appliance => {
            return Ok(NarrowKeyOutcome::Action(UiAction::ToggleZoom));
        }
        _ => {}
    }
    Ok(NarrowKeyOutcome::Continue)
}

fn handle_ui_action(
    action: UiAction,
    model: &ArcUiViewModel,
    state: &mut InteractiveUiState,
    workspace: &Path,
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
) -> Result<()> {
    if let Some(text) = copy_text_for_action(&action, model, state, workspace)? {
        copy_to_clipboard(terminal, state, &text)?;
        return Ok(());
    }
    match action {
        UiAction::OpenSummaryRow(row) => {
            state.narrow_screen = match row {
                0 => NarrowScreen::Capsules,
                1 => NarrowScreen::Declined,
                2 => NarrowScreen::Activity,
                3 => NarrowScreen::Judge,
                _ => NarrowScreen::Injection,
            };
            state.narrow_row = 0;
            state.narrow_scroll = 0;
            state.notice = None;
            if state.narrow_screen == NarrowScreen::Judge && state.judge_models.is_empty() {
                state.judge_models = load_judge_model_choices();
                state.sync_model_selection(model.status.judge.model.as_ref());
            }
        }
        UiAction::OpenCapsule(index) => {
            if index < model.capsules.len() {
                state.selected_capsule = index;
                state.narrow_screen = NarrowScreen::CapsuleDetail;
                state.narrow_scroll = 0;
                state.summary_expanded = false;
                state.expanded_sections.clear();
                state.narrow_row = 0;
                state.notice = None;
            }
        }
        UiAction::Back => {
            state.narrow_screen = match state.narrow_screen {
                NarrowScreen::CapsuleDetail => NarrowScreen::Capsules,
                _ => NarrowScreen::Summary,
            };
            state.narrow_scroll = 0;
        }
        UiAction::ToggleSection(section) => {
            if !state.expanded_sections.remove(&section) {
                state.expanded_sections.insert(section);
            }
        }
        UiAction::ToggleSummary => {
            state.summary_expanded = !state.summary_expanded;
        }
        UiAction::ToggleZoom => {
            toggle_zellij_fullscreen()?;
        }
        UiAction::ToggleJudgeMode => {
            let next = if model.status.judge.mode == "provider-judge" {
                "embedding-only"
            } else {
                "provider-judge"
            };
            save_arc_config(ArcConfigPatch {
                injection_judge_mode: Some(next.to_owned()),
                ..ArcConfigPatch::default()
            })?;
        }
        UiAction::SelectJudge(index) => {
            if let Some(choice) = state.judge_models.get(index) {
                state.selected_judge_model = index;
                save_arc_config(ArcConfigPatch {
                    injection_judge_mode: Some("provider-judge".to_owned()),
                    injection_judge_model: Some(JudgeModel {
                        provider: choice.provider.clone(),
                        id: choice.id.clone(),
                    }),
                    ..ArcConfigPatch::default()
                })?;
            }
        }
        UiAction::SetInjection(choice) => {
            let paused_until = match choice {
                InjectionChoice::Resume => None,
                InjectionChoice::OneHour => Some(pause_until("1h")?),
                InjectionChoice::TwoHours => Some(pause_until("2h")?),
                InjectionChoice::Today => Some(pause_until("today")?),
            };
            save_arc_config(ArcConfigPatch {
                injection_paused_until: Some(
                    paused_until.map(|value| value.to_rfc3339_opts(SecondsFormat::Millis, true)),
                ),
                ..ArcConfigPatch::default()
            })?;
        }
        UiAction::PromoteDeclined(index) => {
            let declined = model
                .declined
                .get(index)
                .ok_or_else(|| anyhow!("Declined draft selection is no longer available"))?;
            let (_, capsule) = promote_declined_draft(&declined.id, workspace)?;
            state.notice = Some(format!("promoted {}", short(&capsule.id, 8)));
            state.selected_declined = state
                .selected_declined
                .min(model.declined.len().saturating_sub(2));
        }
        UiAction::CopySection(_) | UiAction::CopyCommand(_) | UiAction::ShareCapsule => {}
    }
    Ok(())
}

fn copy_text_for_action(
    action: &UiAction,
    model: &ArcUiViewModel,
    state: &InteractiveUiState,
    workspace: &Path,
) -> Result<Option<String>> {
    let Some(row) = model.capsules.get(state.selected_capsule) else {
        return Ok(None);
    };
    match action {
        UiAction::CopySection(section) => Ok(Some(section.values(row).join("\n"))),
        UiAction::CopyCommand(index) => Ok(row.commands.get(*index).cloned()),
        UiAction::ShareCapsule => {
            let capsules = load_capsules(workspace)?;
            let capsule = find_capsule(&capsules, &row.id)
                .ok_or_else(|| anyhow!("Capsule {} no longer exists", row.id))?;
            Ok(Some(capsule_markdown(capsule)))
        }
        _ => Ok(None),
    }
}

fn copy_to_clipboard(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    state: &mut InteractiveUiState,
    value: &str,
) -> Result<()> {
    use base64::Engine;
    let fallback = env::temp_dir().join(format!("arc-clipboard-{}.txt", std::process::id()));
    fs::write(&fallback, value)?;
    let osc52_enabled = env::var("AGENT_RUN_CACHE_OSC52")
        .map(|value| value != "off" && value != "0")
        .unwrap_or_else(|_| {
            env::var("TERM")
                .map(|value| value != "dumb")
                .unwrap_or(true)
        });
    if osc52_enabled {
        let encoded = base64::engine::general_purpose::STANDARD.encode(value.as_bytes());
        write!(terminal.backend_mut(), "\x1b]52;c;{encoded}\x07")?;
        terminal.backend_mut().flush()?;
        state.notice = Some(format!("copied · fallback {}", fallback.display()));
    } else {
        state.notice = Some(format!("saved {}", fallback.display()));
    }
    Ok(())
}

fn toggle_zellij_fullscreen() -> Result<()> {
    if env::var_os("ZELLIJ").is_none() {
        return Err(anyhow!(
            "pane zoom is available when arc ui runs inside arc split"
        ));
    }
    let zellij = cached_zellij().unwrap_or_else(|| PathBuf::from("zellij"));
    let status = Command::new(&zellij)
        .args(["action", "toggle-fullscreen"])
        .status()
        .with_context(|| {
            format!(
                "failed to run {} action toggle-fullscreen",
                zellij.display()
            )
        })?;
    if !status.success() {
        return Err(anyhow!(
            "zellij toggle-fullscreen exited with status {}",
            status.code().unwrap_or(-1)
        ));
    }
    Ok(())
}

#[derive(Debug, Clone)]
struct JudgeModelChoice {
    provider: String,
    id: String,
    name: String,
    cost_hint: Option<String>,
    size_hint: Option<String>,
}

fn draw_ui_frame(
    frame: &mut Frame<'_>,
    model: &ArcUiViewModel,
    state: &InteractiveUiState,
    hit_regions: &mut Vec<HitRegion>,
) {
    let area = frame.area();
    if state.appliance || area.width < NARROW_BREAKPOINT {
        draw_narrow_ui(frame, area, model, state, hit_regions);
        return;
    }
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Length(3),
            Constraint::Min(10),
            Constraint::Length(2),
        ])
        .split(area);

    frame.render_widget(header(model), chunks[0]);
    frame.render_widget(tab_bar(model, state), chunks[1]);

    frame.render_widget(Clear, chunks[2]);
    match state.tab {
        UiTab::Capsules => draw_capsules_tab(frame, chunks[2], model, state),
        UiTab::Activity => draw_activity_tab(frame, chunks[2], model, state),
        UiTab::Declined => draw_declined_tab(frame, chunks[2], model, state, hit_regions),
        UiTab::Settings => draw_settings_tab(frame, chunks[2], model, state),
    }

    let footer = if env::var_os("ZELLIJ").is_some() {
        "q/esc close  tab switch  / filter  j/k move  enter expand  r refresh  s settings    ⤡ split"
    } else {
        "q/esc close  tab switch  / filter  j/k move  enter expand  r refresh  s settings"
    };
    frame.render_widget(
        Paragraph::new(footer).style(Style::default().fg(Color::DarkGray)),
        chunks[3],
    );
    if env::var_os("ZELLIJ").is_some() && !state.appliance {
        hit_regions.push(HitRegion {
            area: Rect::new(
                chunks[3].right().saturating_sub(9),
                chunks[3].y,
                9,
                chunks[3].height,
            ),
            action: UiAction::ToggleZoom,
        });
    }
}

fn draw_narrow_ui(
    frame: &mut Frame<'_>,
    area: Rect,
    model: &ArcUiViewModel,
    state: &InteractiveUiState,
    hit_regions: &mut Vec<HitRegion>,
) {
    frame.render_widget(Clear, area);
    match state.narrow_screen {
        NarrowScreen::Summary => draw_narrow_summary(frame, area, model, state, hit_regions),
        NarrowScreen::Capsules => draw_narrow_capsules(frame, area, model, state, hit_regions),
        NarrowScreen::CapsuleDetail => {
            draw_narrow_capsule_detail(frame, area, model, state, hit_regions)
        }
        NarrowScreen::Activity => draw_narrow_activity(frame, area, model, state, hit_regions),
        NarrowScreen::Declined => draw_narrow_declined(frame, area, model, state, hit_regions),
        NarrowScreen::Judge => draw_narrow_judge(frame, area, model, state, hit_regions),
        NarrowScreen::Injection => draw_narrow_injection(frame, area, model, state, hit_regions),
    }
}

fn draw_narrow_summary(
    frame: &mut Frame<'_>,
    area: Rect,
    model: &ArcUiViewModel,
    state: &InteractiveUiState,
    hit_regions: &mut Vec<HitRegion>,
) {
    let width = area.width.max(1) as usize;
    let judge = model
        .status
        .judge
        .model
        .as_ref()
        .map(|value| value.id.as_str())
        .unwrap_or_else(|| {
            if model.status.judge.mode == "provider-judge" {
                "provider"
            } else {
                "embedding"
            }
        });
    let injection = if model.status.injection_pause.paused {
        model.status.injection_pause.label.as_str()
    } else {
        "on"
    };
    let rows = [
        ("capsules", model.status.capsule_count.to_string()),
        ("declined", model.status.declined_count.to_string()),
        ("activity", model.status.event_count.to_string()),
        ("judge", fit_words(judge, width.saturating_sub(13))),
        ("injection", fit_words(injection, width.saturating_sub(13))),
    ];
    let mut lines = vec![
        Line::from(vec![
            Span::styled(
                "arc",
                Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::raw(" · "),
            Span::styled(
                fit_words(&model.status.repo, width.saturating_sub(6)),
                Style::default().fg(Color::Gray),
            ),
        ]),
        hairline(width),
        Line::raw(""),
    ];
    for (index, (label, value)) in rows.iter().enumerate() {
        let selected = index == state.narrow_row;
        lines.push(settings_row_line(label, value, width, selected));
        lines.push(Line::raw(""));
        let y = area.y.saturating_add(3 + index as u16 * 2);
        if y < area.bottom() {
            hit_regions.push(HitRegion {
                area: Rect::new(area.x, y, area.width, 1),
                action: UiAction::OpenSummaryRow(index),
            });
        }
    }
    if area.height > 15 && !state.appliance {
        lines.push(hairline(width));
        lines.push(Line::from(Span::styled(
            "click a row · scroll to read",
            Style::default().fg(Color::DarkGray),
        )));
    }
    frame.render_widget(Paragraph::new(lines), area);
}

fn draw_narrow_capsules(
    frame: &mut Frame<'_>,
    area: Rect,
    model: &ArcUiViewModel,
    state: &InteractiveUiState,
    hit_regions: &mut Vec<HitRegion>,
) {
    let width = area.width.max(1) as usize;
    let header = Rect::new(area.x, area.y, area.width, area.height.min(2));
    frame.render_widget(
        Paragraph::new(vec![
            Line::from(vec![
                Span::styled(
                    "‹ capsules",
                    Style::default()
                        .fg(Color::Cyan)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    format!(" · {}", model.capsules.len()),
                    Style::default().fg(Color::DarkGray),
                ),
            ]),
            hairline(width),
        ]),
        header,
    );
    hit_regions.push(HitRegion {
        area: Rect::new(area.x, area.y, area.width, 1),
        action: UiAction::Back,
    });

    if area.height <= 2 {
        return;
    }
    let body = Rect::new(
        area.x,
        area.y + 2,
        area.width,
        area.height.saturating_sub(2),
    );
    if model.capsules.is_empty() {
        frame.render_widget(
            Paragraph::new("No capsules saved yet.").style(Style::default().fg(Color::DarkGray)),
            body,
        );
        return;
    }

    let mut lines = Vec::new();
    let mut line_actions = Vec::new();
    for (index, capsule) in model.capsules.iter().enumerate() {
        let selected = index == state.selected_capsule;
        let style = if selected {
            Style::default()
                .fg(Color::White)
                .bg(Color::Rgb(20, 34, 45))
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(Color::White)
        };
        lines.push(Line::styled(
            clip_text(&capsule.title, width.saturating_sub(1)),
            style,
        ));
        line_actions.push(Some(UiAction::OpenCapsule(index)));
        lines.push(Line::from(vec![
            Span::styled(
                format!("{}%", (capsule.confidence * 100.0).round() as i64),
                Style::default().fg(confidence_color((capsule.confidence * 100.0).round() as u8)),
            ),
            Span::raw(" · "),
            Span::styled(
                age(&capsule.updated_at),
                Style::default().fg(Color::DarkGray),
            ),
            Span::raw(" · "),
            Span::styled(
                capsule.short_id.clone(),
                Style::default().fg(Color::DarkGray),
            ),
            Span::raw(" ›"),
        ]));
        line_actions.push(Some(UiAction::OpenCapsule(index)));
        lines.push(hairline(width));
        line_actions.push(None);
    }
    render_narrow_document(
        frame,
        body,
        lines,
        line_actions,
        Vec::new(),
        state.narrow_scroll,
        hit_regions,
    );
}

fn draw_narrow_declined(
    frame: &mut Frame<'_>,
    area: Rect,
    model: &ArcUiViewModel,
    state: &InteractiveUiState,
    hit_regions: &mut Vec<HitRegion>,
) {
    let width = area.width.max(1) as usize;
    let header = Rect::new(area.x, area.y, area.width, area.height.min(2));
    frame.render_widget(
        Paragraph::new(vec![
            Line::from(vec![
                Span::styled(
                    "‹ declined",
                    Style::default()
                        .fg(Color::Cyan)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    format!(" · {}", model.declined.len()),
                    Style::default().fg(Color::DarkGray),
                ),
            ]),
            hairline(width),
        ]),
        header,
    );
    hit_regions.push(HitRegion {
        area: Rect::new(area.x, area.y, area.width, 1),
        action: UiAction::Back,
    });
    if area.height <= 2 {
        return;
    }
    let body = Rect::new(
        area.x,
        area.y + 2,
        area.width,
        area.height.saturating_sub(2),
    );
    if model.declined.is_empty() {
        frame.render_widget(
            Paragraph::new("No declined drafts.").style(Style::default().fg(Color::DarkGray)),
            body,
        );
        return;
    }

    let mut lines = Vec::new();
    let mut actions = Vec::new();
    for (index, declined) in model.declined.iter().enumerate() {
        let selected = index == state.selected_declined;
        let style = if selected {
            Style::default()
                .fg(Color::White)
                .bg(Color::Rgb(20, 34, 45))
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(Color::White)
        };
        lines.push(Line::styled(
            clip_text(&declined.title, width.saturating_sub(1)),
            style,
        ));
        actions.push(None);
        lines.push(Line::from(vec![
            Span::styled(
                declined.outcome.clone(),
                Style::default().fg(outcome_color(&declined.outcome)),
            ),
            Span::raw(" · "),
            Span::styled(
                age_from_seconds(declined.age_seconds),
                Style::default().fg(Color::DarkGray),
            ),
        ]));
        actions.push(None);
        lines.push(Line::from(Span::styled(
            "[ Promote ]",
            Style::default()
                .fg(Color::Black)
                .bg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        )));
        actions.push(Some(UiAction::PromoteDeclined(index)));
        lines.push(hairline(width));
        actions.push(None);
    }
    if let Some(notice) = &state.notice {
        lines.push(Line::from(Span::styled(
            clip_text(notice, width),
            Style::default().fg(Color::Green),
        )));
        actions.push(None);
    }
    render_narrow_document(
        frame,
        body,
        lines,
        actions,
        Vec::new(),
        state.narrow_scroll,
        hit_regions,
    );
}

fn draw_narrow_capsule_detail(
    frame: &mut Frame<'_>,
    area: Rect,
    model: &ArcUiViewModel,
    state: &InteractiveUiState,
    hit_regions: &mut Vec<HitRegion>,
) {
    let Some(capsule) = model.capsules.get(state.selected_capsule) else {
        draw_narrow_capsules(frame, area, model, state, hit_regions);
        return;
    };
    let width = area.width.max(1) as usize;
    let footer_height = area.height.min(2);
    let body_height = area.height.saturating_sub(footer_height);
    let body = Rect::new(area.x, area.y, area.width, body_height);
    let footer = Rect::new(
        area.x,
        area.y.saturating_add(body_height),
        area.width,
        footer_height,
    );

    let mut lines = vec![
        Line::from(Span::styled(
            format!("‹ {}", clip_text(&capsule.title, width.saturating_sub(2))),
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        )),
        hairline(width),
        Line::from(vec![
            pill(&capsule.kind, Color::Magenta),
            Span::raw(" "),
            pill(&privacy_label(&capsule.privacy_label), Color::Blue),
        ]),
        Line::from(Span::styled(
            format!(
                "{}% · {} · {}",
                (capsule.confidence * 100.0).round() as i64,
                age(&capsule.updated_at),
                capsule.short_id
            ),
            Style::default().fg(Color::DarkGray),
        )),
        hairline(width),
        Line::from(Span::styled(
            "summary",
            Style::default()
                .fg(Color::DarkGray)
                .add_modifier(Modifier::BOLD),
        )),
    ];
    let mut actions = vec![Some(UiAction::Back), None, None, None, None, None];
    let mut trailing_actions = vec![None; actions.len()];
    let summary_lines = wrap_words(&capsule.summary, width);
    let summary_limit = if state.summary_expanded {
        summary_lines.len()
    } else {
        summary_lines.len().min(3)
    };
    for line in summary_lines.iter().take(summary_limit) {
        lines.push(Line::raw(line.clone()));
        actions.push(None);
        trailing_actions.push(None);
    }
    if summary_lines.len() > 3 {
        lines.push(Line::from(Span::styled(
            if state.summary_expanded {
                "less ▴"
            } else {
                "more ▾"
            },
            Style::default().fg(Color::Cyan),
        )));
        actions.push(Some(UiAction::ToggleSummary));
        trailing_actions.push(None);
    }
    lines.push(hairline(width));
    actions.push(None);
    trailing_actions.push(None);

    for (section_index, section) in visible_detail_sections(capsule).into_iter().enumerate() {
        let values = section.values(capsule);
        let expanded = state.expanded_sections.contains(&section);
        lines.push(section_row_line(
            section.label(),
            values.len(),
            width,
            expanded,
            section_index == state.narrow_row,
        ));
        actions.push(Some(UiAction::ToggleSection(section)));
        trailing_actions.push(Some(UiAction::CopySection(section)));
        if expanded {
            for (index, value) in values.iter().enumerate() {
                let prefix = format!("{}.", index + 1);
                let indent = " ".repeat(prefix.len() + 1);
                let is_command = section == DetailSection::Commands;
                let suffix = if is_command { " ⧉" } else { "" };
                let content_width = width
                    .saturating_sub(prefix.len() + 1 + suffix.chars().count())
                    .max(1);
                let segments = wrap_words(value, content_width);
                let segments = if segments.is_empty() {
                    vec![String::new()]
                } else {
                    segments
                };
                for (segment_index, segment) in segments.iter().enumerate() {
                    let first = segment_index == 0;
                    let mut spans = if first {
                        vec![
                            Span::styled(prefix.clone(), Style::default().fg(Color::DarkGray)),
                            Span::raw(" "),
                        ]
                    } else {
                        vec![Span::raw(indent.clone())]
                    };
                    spans.push(Span::raw(segment.clone()));
                    if first && is_command {
                        spans.push(Span::styled(suffix, Style::default().fg(Color::Cyan)));
                    }
                    lines.push(Line::from(spans));
                    actions.push(None);
                    trailing_actions
                        .push((first && is_command).then_some(UiAction::CopyCommand(index)));
                }
            }
        }
    }
    if let Some(notice) = &state.notice {
        lines.push(Line::from(Span::styled(
            clip_text(notice, width),
            Style::default().fg(Color::Green),
        )));
        actions.push(None);
        trailing_actions.push(None);
    }
    lines.push(hairline(width));
    actions.push(None);
    trailing_actions.push(None);

    render_narrow_document(
        frame,
        body,
        lines,
        actions,
        trailing_actions,
        state.narrow_scroll,
        hit_regions,
    );

    if footer.height > 0 {
        let footer_line = if state.appliance {
            Line::from(vec![
                Span::styled("‹ back", Style::default().fg(Color::Cyan)),
                Span::styled(" · ", Style::default().fg(Color::DarkGray)),
                Span::styled("copy", Style::default().fg(Color::Cyan)),
            ])
        } else {
            Line::from(vec![
                Span::styled("‹ back", Style::default().fg(Color::Cyan)),
                Span::styled(" · ", Style::default().fg(Color::DarkGray)),
                Span::styled("⤢ full", Style::default().fg(Color::Cyan)),
                Span::styled(" · ", Style::default().fg(Color::DarkGray)),
                Span::styled("copy", Style::default().fg(Color::Cyan)),
            ])
        };
        frame.render_widget(Paragraph::new(vec![hairline(width), footer_line]), footer);
        if footer.height > 1 {
            hit_regions.push(HitRegion {
                area: Rect::new(footer.x, footer.y + 1, 7.min(footer.width), 1),
                action: UiAction::Back,
            });
            if footer.width > 9 && !state.appliance {
                hit_regions.push(HitRegion {
                    area: Rect::new(footer.x + 9, footer.y + 1, 7.min(footer.width - 9), 1),
                    action: UiAction::ToggleZoom,
                });
            }
            let copy_x = if state.appliance { 9 } else { 18 };
            if footer.width > copy_x {
                hit_regions.push(HitRegion {
                    area: Rect::new(
                        footer.x + copy_x,
                        footer.y + 1,
                        footer.width.saturating_sub(copy_x),
                        1,
                    ),
                    action: UiAction::ShareCapsule,
                });
            }
        }
    }
}

fn draw_narrow_activity(
    frame: &mut Frame<'_>,
    area: Rect,
    model: &ArcUiViewModel,
    state: &InteractiveUiState,
    hit_regions: &mut Vec<HitRegion>,
) {
    let width = area.width.max(1) as usize;
    let mut lines = vec![
        Line::from(Span::styled(
            format!("‹ activity · {}", model.recent_events.len()),
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        )),
        hairline(width),
    ];
    let mut actions = vec![Some(UiAction::Back), None];
    for event in &model.recent_events {
        lines.push(Line::from(vec![
            Span::styled(
                clip_text(&event_label(&event.r#type), width.saturating_sub(5)),
                Style::default().fg(event_color(&event.r#type)),
            ),
            Span::raw(" "),
            Span::styled(age(&event.timestamp), Style::default().fg(Color::DarkGray)),
        ]));
        actions.push(None);
        if !event.detail.is_empty() {
            lines.push(Line::from(Span::styled(
                clip_text(&event.detail, width),
                Style::default().fg(Color::DarkGray),
            )));
            actions.push(None);
        }
        lines.push(hairline(width));
        actions.push(None);
    }
    render_narrow_document(
        frame,
        area,
        lines,
        actions,
        Vec::new(),
        state.narrow_scroll,
        hit_regions,
    );
}

fn draw_narrow_judge(
    frame: &mut Frame<'_>,
    area: Rect,
    model: &ArcUiViewModel,
    state: &InteractiveUiState,
    hit_regions: &mut Vec<HitRegion>,
) {
    let width = area.width.max(1) as usize;
    let mode = if model.status.judge.mode == "provider-judge" {
        "provider"
    } else {
        "embedding"
    };
    let mut lines = vec![
        Line::from(Span::styled(
            "‹ judge",
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        )),
        hairline(width),
        Line::raw(""),
        settings_row_line("mode", mode, width, state.narrow_row == 0),
        settings_row_line(
            "status",
            if model.status.judge.reachability.reachable {
                "reachable"
            } else {
                "unreachable"
            },
            width,
            false,
        ),
        Line::from(Span::styled(
            fit_words(
                &model.status.judge.reachability.reason,
                width.saturating_sub(2),
            ),
            Style::default().fg(Color::DarkGray),
        )),
        hairline(width),
    ];
    let mut actions = vec![
        Some(UiAction::Back),
        None,
        None,
        Some(UiAction::ToggleJudgeMode),
        None,
        None,
        None,
    ];
    for (index, choice) in state.judge_models.iter().enumerate() {
        let active = model
            .status
            .judge
            .model
            .as_ref()
            .map(|model| model.provider == choice.provider && model.id == choice.id)
            .unwrap_or(false);
        let label = if active {
            format!("{} ✓", choice.id)
        } else {
            choice.id.clone()
        };
        lines.push(settings_row_line(
            &choice.provider,
            &label,
            width,
            state.narrow_row == index + 1,
        ));
        actions.push(Some(UiAction::SelectJudge(index)));
    }
    render_narrow_document(
        frame,
        area,
        lines,
        actions,
        Vec::new(),
        state.narrow_scroll,
        hit_regions,
    );
}

fn draw_narrow_injection(
    frame: &mut Frame<'_>,
    area: Rect,
    model: &ArcUiViewModel,
    state: &InteractiveUiState,
    hit_regions: &mut Vec<HitRegion>,
) {
    let width = area.width.max(1) as usize;
    let value = if model.status.injection_pause.paused {
        model.status.injection_pause.label.as_str()
    } else {
        "on"
    };
    let choices = [
        ("resume", InjectionChoice::Resume),
        ("pause 1 hour", InjectionChoice::OneHour),
        ("pause 2 hours", InjectionChoice::TwoHours),
        ("pause today", InjectionChoice::Today),
    ];
    let mut lines = vec![
        Line::from(Span::styled(
            "‹ injection",
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        )),
        hairline(width),
        settings_row_line("status", value, width, false),
        hairline(width),
    ];
    let mut actions = vec![Some(UiAction::Back), None, None, None];
    for (index, (label, choice)) in choices.into_iter().enumerate() {
        lines.push(settings_row_line(
            label,
            "",
            width,
            state.narrow_row == index,
        ));
        actions.push(Some(UiAction::SetInjection(choice)));
    }
    render_narrow_document(
        frame,
        area,
        lines,
        actions,
        Vec::new(),
        state.narrow_scroll,
        hit_regions,
    );
}

fn render_narrow_document(
    frame: &mut Frame<'_>,
    area: Rect,
    lines: Vec<Line<'static>>,
    actions: Vec<Option<UiAction>>,
    trailing_actions: Vec<Option<UiAction>>,
    requested_scroll: u16,
    hit_regions: &mut Vec<HitRegion>,
) {
    let max_scroll = lines.len().saturating_sub(area.height as usize) as u16;
    let scroll = requested_scroll.min(max_scroll);
    let visible = lines
        .into_iter()
        .skip(scroll as usize)
        .take(area.height as usize)
        .collect::<Vec<_>>();
    frame.render_widget(Paragraph::new(visible), area);
    for (index, action) in actions
        .into_iter()
        .enumerate()
        .skip(scroll as usize)
        .take(area.height as usize)
    {
        if let Some(action) = action {
            hit_regions.push(HitRegion {
                area: Rect::new(area.x, area.y + index as u16 - scroll, area.width, 1),
                action,
            });
        }
    }
    for (index, action) in trailing_actions
        .into_iter()
        .enumerate()
        .skip(scroll as usize)
        .take(area.height as usize)
    {
        if let Some(action) = action {
            hit_regions.push(HitRegion {
                area: Rect::new(
                    area.right().saturating_sub(2),
                    area.y + index as u16 - scroll,
                    area.width.min(2),
                    1,
                ),
                action,
            });
        }
    }
}

impl DetailSection {
    const ALL: [DetailSection; 7] = [
        DetailSection::ReuseWhen,
        DetailSection::Steps,
        DetailSection::Commands,
        DetailSection::Evidence,
        DetailSection::DoNotReuseWhen,
        DetailSection::Validation,
        DetailSection::FailedAttempts,
    ];

    fn label(self) -> &'static str {
        match self {
            DetailSection::ReuseWhen => "reuse when",
            DetailSection::Steps => "steps",
            DetailSection::Commands => "commands",
            DetailSection::Evidence => "evidence",
            DetailSection::DoNotReuseWhen => "avoid when",
            DetailSection::Validation => "validation",
            DetailSection::FailedAttempts => "dead ends",
        }
    }

    fn values(self, capsule: &ArcUiCapsuleRow) -> &[String] {
        match self {
            DetailSection::ReuseWhen => &capsule.reuse_when,
            DetailSection::Steps => &capsule.steps,
            DetailSection::Commands => &capsule.commands,
            DetailSection::Evidence => &capsule.evidence,
            DetailSection::DoNotReuseWhen => &capsule.do_not_reuse_when,
            DetailSection::Validation => &capsule.validation_probe,
            DetailSection::FailedAttempts => &capsule.failed_attempts,
        }
    }
}

fn visible_detail_sections(capsule: &ArcUiCapsuleRow) -> Vec<DetailSection> {
    DetailSection::ALL
        .into_iter()
        .filter(|section| !section.values(capsule).is_empty())
        .collect()
}

fn hairline(width: usize) -> Line<'static> {
    Line::from(Span::styled(
        "─".repeat(width),
        Style::default().fg(Color::DarkGray),
    ))
}

fn settings_row_line(label: &str, value: &str, width: usize, selected: bool) -> Line<'static> {
    let arrow = " ›";
    let available = width.saturating_sub(arrow.chars().count());
    let label_width = label.chars().count();
    let value = clip_text(value, available.saturating_sub(label_width + 1));
    let padding = available
        .saturating_sub(label_width)
        .saturating_sub(value.chars().count());
    let style = if selected {
        Style::default()
            .fg(Color::White)
            .bg(Color::Rgb(20, 34, 45))
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(Color::White)
    };
    Line::from(vec![
        Span::styled(label.to_owned(), style),
        Span::styled(" ".repeat(padding), style),
        Span::styled(value, style.fg(Color::Gray)),
        Span::styled(arrow, style.fg(Color::Cyan)),
    ])
}

fn section_row_line(
    label: &str,
    count: usize,
    width: usize,
    expanded: bool,
    selected: bool,
) -> Line<'static> {
    let marker = if expanded { " ‹ ⧉" } else { " › ⧉" };
    let count = count.to_string();
    let used = label.chars().count() + count.chars().count() + marker.chars().count();
    let style = if selected {
        Style::default().bg(Color::Rgb(20, 34, 45))
    } else {
        Style::default()
    };
    Line::from(vec![
        Span::styled(
            label.to_owned(),
            style.fg(Color::White).add_modifier(Modifier::BOLD),
        ),
        Span::styled(" ".repeat(width.saturating_sub(used)), style),
        Span::styled(count, style.fg(Color::DarkGray)),
        Span::styled(marker, style.fg(Color::Cyan)),
    ])
}

fn clip_text(value: &str, max: usize) -> String {
    let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if value.chars().count() <= max {
        return value;
    }
    if max <= 1 {
        return "…".repeat(max);
    }
    value.chars().take(max - 1).collect::<String>() + "…"
}

fn wrap_words(value: &str, width: usize) -> Vec<String> {
    let width = width.max(1);
    let mut lines = Vec::new();
    let mut current = String::new();
    for word in value.split_whitespace() {
        if word.chars().count() > width {
            if !current.is_empty() {
                lines.push(current);
                current = String::new();
            }
            let chars = word.chars().collect::<Vec<_>>();
            for chunk in chars.chunks(width) {
                lines.push(chunk.iter().collect());
            }
            continue;
        }
        let projected =
            current.chars().count() + if current.is_empty() { 0 } else { 1 } + word.chars().count();
        if projected > width && !current.is_empty() {
            lines.push(current);
            current = word.to_owned();
        } else {
            if !current.is_empty() {
                current.push(' ');
            }
            current.push_str(word);
        }
    }
    if !current.is_empty() {
        lines.push(current);
    }
    if lines.is_empty() {
        lines.push(String::new());
    }
    lines
}

fn header(model: &ArcUiViewModel) -> Paragraph<'static> {
    let judge = judge_label(&model.status.judge);
    let pause = if model.status.injection_pause.paused {
        Some(Span::styled(
            model.status.injection_pause.label.clone(),
            Style::default().fg(Color::Yellow),
        ))
    } else {
        None
    };
    let mut spans = vec![
        Span::styled(
            "ARC",
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        ),
        Span::raw(" · "),
        Span::styled(
            format!("{} capsules", model.status.capsule_count),
            Style::default()
                .fg(Color::Blue)
                .add_modifier(Modifier::BOLD),
        ),
        Span::raw(" · "),
        Span::raw(format!("{} events", model.status.event_count)),
        Span::raw(" · "),
        Span::styled(
            format!("judge {judge}"),
            Style::default().fg(Color::Magenta),
        ),
    ];
    if let Some(pause) = pause {
        spans.push(Span::raw(" · "));
        spans.push(pause);
    }
    spans.extend([
        Span::raw(" · "),
        Span::styled(
            model.status.repo.clone(),
            Style::default().fg(Color::DarkGray),
        ),
    ]);
    Paragraph::new(Line::from(spans)).block(Block::default().borders(Borders::BOTTOM))
}

fn tab_bar(model: &ArcUiViewModel, state: &InteractiveUiState) -> Paragraph<'static> {
    let seam = if model.status.integration.as_deref() == Some("copilot-plugin") {
        "plugin active"
    } else if model.status.hook["installed"].as_bool().unwrap_or(false) {
        "hook live"
    } else {
        "plugin pending"
    };
    Paragraph::new(Line::from(vec![
        tab_span("1 Capsules", state.tab == UiTab::Capsules),
        Span::raw("  "),
        tab_span("2 Activity", state.tab == UiTab::Activity),
        Span::raw("  "),
        tab_span("3 Settings", state.tab == UiTab::Settings),
        Span::raw("   "),
        tab_span("4 Declined", state.tab == UiTab::Declined),
        Span::raw("   "),
        Span::styled(seam, Style::default().fg(Color::DarkGray)),
        Span::raw("   filter "),
        Span::styled(
            if state.filter_editing {
                format!("> {}", state.filter)
            } else if state.filter.is_empty() {
                "all capsules".to_owned()
            } else {
                state.filter.clone()
            },
            Style::default().fg(if state.filter_editing {
                Color::Yellow
            } else {
                Color::DarkGray
            }),
        ),
    ]))
}

fn tab_span(label: &'static str, active: bool) -> Span<'static> {
    if active {
        Span::styled(
            format!(" {label} "),
            Style::default()
                .fg(Color::Black)
                .bg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        )
    } else {
        Span::styled(format!(" {label} "), Style::default().fg(Color::Cyan))
    }
}

fn draw_capsules_tab(
    frame: &mut Frame<'_>,
    area: Rect,
    model: &ArcUiViewModel,
    state: &InteractiveUiState,
) {
    let horizontal = area.width >= 90;
    let body = Layout::default()
        .direction(if horizontal {
            Direction::Horizontal
        } else {
            Direction::Vertical
        })
        .constraints(if horizontal {
            [Constraint::Percentage(48), Constraint::Percentage(52)]
        } else {
            [Constraint::Percentage(45), Constraint::Percentage(55)]
        })
        .split(area);

    let list_width = body[0].width.saturating_sub(4).max(20);
    let items = if model.capsules.is_empty() {
        vec![ListItem::new(Line::from(Span::styled(
            "No capsules saved yet. ARC saves verified reusable methods after successful sessions.",
            Style::default().fg(Color::DarkGray),
        )))]
    } else {
        model
            .capsules
            .iter()
            .map(|capsule| capsule_item(capsule, list_width))
            .collect()
    };
    let mut list_state = ListState::default();
    if !model.capsules.is_empty() {
        list_state.select(Some(state.selected_capsule));
    }
    frame.render_stateful_widget(
        List::new(items)
            .block(Block::default().title("Capsules").borders(Borders::ALL))
            .highlight_symbol("› ")
            .highlight_style(Style::default().bg(Color::Rgb(20, 34, 45))),
        body[0],
        &mut list_state,
    );

    let selected = model.capsules.get(state.selected_capsule);
    frame.render_widget(detail_pane(selected, state.expanded), body[1]);
}

fn draw_declined_tab(
    frame: &mut Frame<'_>,
    area: Rect,
    model: &ArcUiViewModel,
    state: &InteractiveUiState,
    hit_regions: &mut Vec<HitRegion>,
) {
    let body = Layout::default()
        .direction(if area.width >= 90 {
            Direction::Horizontal
        } else {
            Direction::Vertical
        })
        .constraints([Constraint::Percentage(48), Constraint::Percentage(52)])
        .split(area);
    let list_width = body[0].width.saturating_sub(4).max(20) as usize;
    let items = if model.declined.is_empty() {
        vec![ListItem::new(Line::from(Span::styled(
            "No declined drafts.",
            Style::default().fg(Color::DarkGray),
        )))]
    } else {
        model
            .declined
            .iter()
            .map(|declined| {
                ListItem::new(vec![
                    Line::from(vec![
                        Span::styled(
                            declined.outcome.clone(),
                            Style::default().fg(outcome_color(&declined.outcome)),
                        ),
                        Span::raw(" · "),
                        Span::styled(
                            age_from_seconds(declined.age_seconds),
                            Style::default().fg(Color::DarkGray),
                        ),
                    ]),
                    Line::from(Span::styled(
                        fit_words(&declined.title, list_width),
                        Style::default().add_modifier(Modifier::BOLD),
                    )),
                    Line::from(Span::styled(
                        fit_words(&declined.reason, list_width),
                        Style::default().fg(Color::DarkGray),
                    )),
                    Line::raw(""),
                ])
            })
            .collect()
    };
    let mut list_state = ListState::default();
    if !model.declined.is_empty() {
        list_state.select(Some(state.selected_declined));
    }
    frame.render_stateful_widget(
        List::new(items)
            .block(Block::default().title("Declined").borders(Borders::ALL))
            .highlight_symbol("› ")
            .highlight_style(Style::default().bg(Color::Rgb(20, 34, 45))),
        body[0],
        &mut list_state,
    );

    let detail = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(5), Constraint::Length(3)])
        .split(body[1]);
    let selected = model.declined.get(state.selected_declined);
    let detail_text = selected.map_or_else(
        || "Select a declined draft.".to_owned(),
        |declined| {
            format!(
                "{}\n\n{}\n\nReason: {}\nSession: {}",
                declined.title, declined.summary, declined.reason, declined.session_id
            )
        },
    );
    frame.render_widget(
        Paragraph::new(detail_text)
            .wrap(Wrap { trim: true })
            .block(Block::default().title("Detail").borders(Borders::ALL)),
        detail[0],
    );
    if selected.is_some() {
        frame.render_widget(
            Paragraph::new(" Promote ")
                .alignment(ratatui::layout::Alignment::Center)
                .style(
                    Style::default()
                        .fg(Color::Black)
                        .bg(Color::Cyan)
                        .add_modifier(Modifier::BOLD),
                )
                .block(Block::default().borders(Borders::ALL)),
            detail[1],
        );
        hit_regions.push(HitRegion {
            area: detail[1],
            action: UiAction::PromoteDeclined(state.selected_declined),
        });
    }
}

fn outcome_color(outcome: &str) -> Color {
    match outcome {
        "success" => Color::Green,
        "failed" | "aborted" => Color::Red,
        "partial" => Color::Yellow,
        _ => Color::DarkGray,
    }
}

fn capsule_item(capsule: &ArcUiCapsuleRow, width: u16) -> ListItem<'static> {
    let confidence = (capsule.confidence * 100.0).round().clamp(0.0, 100.0) as u8;
    let title_width = width.saturating_sub(2).max(16) as usize;
    ListItem::new(vec![
        Line::from(vec![
            Span::styled("●", Style::default().fg(status_color(&capsule.status))),
            Span::raw(" "),
            pill(&capsule.kind, Color::Magenta),
            Span::raw(" "),
            pill(&privacy_label(&capsule.privacy_label), Color::Blue),
            Span::raw(" "),
            Span::styled(
                format!("{confidence:>3}% {}", confidence_bar(confidence)),
                Style::default().fg(confidence_color(confidence)),
            ),
            Span::raw(" "),
            Span::styled(
                age(&capsule.updated_at),
                Style::default().fg(Color::DarkGray),
            ),
        ]),
        Line::from(Span::styled(
            fit_words(&capsule.title, title_width),
            Style::default().add_modifier(Modifier::BOLD),
        )),
        Line::from(Span::styled(
            fit_words(&capsule.summary, title_width),
            Style::default().fg(Color::DarkGray),
        )),
        Line::raw(""),
    ])
}

fn detail_pane(capsule: Option<&ArcUiCapsuleRow>, expanded: bool) -> Paragraph<'static> {
    let mut lines = Vec::new();
    let Some(capsule) = capsule else {
        return Paragraph::new("Select a capsule.")
            .style(Style::default().fg(Color::DarkGray))
            .block(Block::default().title("Detail").borders(Borders::ALL));
    };
    lines.push(Line::from(Span::styled(
        capsule.title.clone(),
        Style::default().add_modifier(Modifier::BOLD),
    )));
    lines.push(Line::from(Span::styled(
        format!(
            "id {} | uses {} | {}% confidence",
            capsule.short_id,
            capsule.use_count,
            (capsule.confidence * 100.0).round() as i64
        ),
        Style::default().fg(Color::DarkGray),
    )));
    lines.push(Line::raw(""));
    push_section(
        &mut lines,
        "SUMMARY",
        std::slice::from_ref(&capsule.summary),
    );
    push_section(&mut lines, "REUSE WHEN", &capsule.reuse_when);
    let step_limit = if expanded { 8 } else { 3 };
    push_section(
        &mut lines,
        "STEPS",
        &capsule
            .steps
            .iter()
            .take(step_limit)
            .cloned()
            .collect::<Vec<_>>(),
    );
    let command_limit = if expanded { 6 } else { 3 };
    push_section(
        &mut lines,
        "COMMAND SHAPES",
        &capsule
            .commands
            .iter()
            .take(command_limit)
            .cloned()
            .collect::<Vec<_>>(),
    );
    if expanded && !capsule.validation_probe.is_empty() {
        push_section(&mut lines, "VALIDATION", &capsule.validation_probe);
    }
    Paragraph::new(lines)
        .wrap(Wrap { trim: false })
        .block(Block::default().title("Detail").borders(Borders::ALL))
}

fn draw_activity_tab(
    frame: &mut Frame<'_>,
    area: Rect,
    model: &ArcUiViewModel,
    state: &InteractiveUiState,
) {
    let items = if model.recent_events.is_empty() {
        vec![ListItem::new(Line::from(Span::styled(
            "No ARC activity yet.",
            Style::default().fg(Color::DarkGray),
        )))]
    } else {
        model.recent_events.iter().map(activity_item).collect()
    };
    let mut list_state = ListState::default();
    if !model.recent_events.is_empty() {
        list_state.select(Some(state.selected_event));
    }
    frame.render_stateful_widget(
        List::new(items)
            .block(Block::default().title("Activity").borders(Borders::ALL))
            .highlight_symbol("› ")
            .highlight_style(Style::default().bg(Color::Rgb(20, 34, 45))),
        area,
        &mut list_state,
    );
}

fn activity_item(event: &ArcUiEventRow) -> ListItem<'static> {
    ListItem::new(vec![
        Line::from(vec![
            Span::styled(
                event_label(&event.r#type),
                Style::default()
                    .fg(event_color(&event.r#type))
                    .add_modifier(Modifier::BOLD),
            ),
            Span::raw("  "),
            Span::styled(age(&event.timestamp), Style::default().fg(Color::DarkGray)),
        ]),
        Line::from(Span::styled(
            if event.detail.is_empty() {
                event.session_id.clone().unwrap_or_default()
            } else {
                event.detail.clone()
            },
            Style::default().fg(Color::Gray),
        )),
    ])
}

fn draw_settings_tab(
    frame: &mut Frame<'_>,
    area: Rect,
    model: &ArcUiViewModel,
    state: &InteractiveUiState,
) {
    let mode = model.status.judge.mode.as_str();
    let selected_model = state
        .judge_models
        .get(state.selected_judge_model)
        .map(|choice| choice.label())
        .or_else(|| {
            model
                .status
                .judge
                .model
                .as_ref()
                .map(|model| format!("{}:{}", model.provider, model.id))
        })
        .unwrap_or_else(|| "none".to_owned());
    let mut lines = vec![
        settings_line("Mode", mode, state.settings_row == 0),
        settings_line("Model", &selected_model, state.settings_row == 1),
        settings_line(
            "Reachability",
            if model.status.judge.reachability.reachable {
                "reachable"
            } else {
                "unreachable"
            },
            false,
        ),
        Line::from(Span::styled(
            model.status.judge.reachability.reason.clone(),
            Style::default().fg(Color::DarkGray),
        )),
        Line::raw(""),
        Line::from(Span::styled(
            "Use ↑/↓ to choose a setting, ←/→ or enter to change it. Settings persist to ARC config and are used by hooks, MCP, and probe.",
            Style::default().fg(Color::DarkGray),
        )),
        Line::raw(""),
        Line::from(Span::styled(
            "Available judge models",
            Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD),
        )),
    ];
    if state.judge_models.is_empty() {
        lines.push(Line::from(Span::styled(
            "No judge-capable models found. Start Ollama or set a model with arc judge set --model provider:id.",
            Style::default().fg(Color::DarkGray),
        )));
    } else {
        for (index, choice) in state.judge_models.iter().take(12).enumerate() {
            let active = index == state.selected_judge_model;
            lines.push(Line::from(vec![
                Span::styled(
                    if active { "› " } else { "  " },
                    Style::default().fg(Color::Cyan),
                ),
                Span::styled(
                    choice.label(),
                    if active {
                        Style::default()
                            .fg(Color::White)
                            .add_modifier(Modifier::BOLD)
                    } else {
                        Style::default().fg(Color::Gray)
                    },
                ),
            ]));
        }
    }
    frame.render_widget(
        Paragraph::new(lines)
            .wrap(Wrap { trim: false })
            .block(Block::default().title("Settings").borders(Borders::ALL)),
        area,
    );
}

fn settings_line(label: &'static str, value: &str, selected: bool) -> Line<'static> {
    Line::from(vec![
        Span::styled(
            if selected { "› " } else { "  " },
            Style::default().fg(Color::Cyan),
        ),
        Span::styled(
            format!("{label:<8}"),
            Style::default()
                .fg(if selected {
                    Color::Cyan
                } else {
                    Color::DarkGray
                })
                .add_modifier(Modifier::BOLD),
        ),
        Span::raw(" "),
        Span::styled(
            value.to_owned(),
            if selected {
                Style::default()
                    .fg(Color::White)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(Color::Gray)
            },
        ),
    ])
}

impl JudgeModelChoice {
    fn label(&self) -> String {
        let mut suffix = Vec::new();
        if self.name != self.id {
            suffix.push(self.name.clone());
        }
        if let Some(size) = &self.size_hint {
            suffix.push(size.clone());
        }
        if let Some(cost) = &self.cost_hint {
            suffix.push(cost.clone());
        }
        if suffix.is_empty() {
            format!("{}:{}", self.provider, self.id)
        } else {
            format!("{}:{} ({})", self.provider, self.id, suffix.join(", "))
        }
    }
}

fn load_judge_model_choices() -> Vec<JudgeModelChoice> {
    list_judge_models()["models"]
        .as_array()
        .map(|models| {
            models
                .iter()
                .filter_map(|value| {
                    Some(JudgeModelChoice {
                        provider: value.get("provider")?.as_str()?.to_owned(),
                        id: value.get("id")?.as_str()?.to_owned(),
                        name: value
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or_else(|| {
                                value.get("id").and_then(Value::as_str).unwrap_or("")
                            })
                            .to_owned(),
                        cost_hint: value
                            .get("costHint")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        size_hint: value
                            .get("sizeHint")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn adjust_settings_selection(state: &mut InteractiveUiState, delta: isize) -> Result<()> {
    match state.settings_row {
        0 => {
            let next = if load_arc_config()?
                .injection_judge_mode
                .as_deref()
                .unwrap_or("embedding-only")
                == "provider-judge"
            {
                "embedding-only"
            } else {
                "provider-judge"
            };
            save_arc_config(ArcConfigPatch {
                injection_judge_mode: Some(next.to_owned()),
                ..ArcConfigPatch::default()
            })?;
        }
        1 => {
            if state.judge_models.is_empty() {
                return Ok(());
            }
            let len = state.judge_models.len() as isize;
            let current = state.selected_judge_model as isize;
            state.selected_judge_model = ((current + delta).rem_euclid(len)) as usize;
            apply_settings_selection(state)?;
        }
        _ => {}
    }
    Ok(())
}

fn apply_settings_selection(state: &mut InteractiveUiState) -> Result<()> {
    if state.settings_row == 0 {
        return adjust_settings_selection(state, 1);
    }
    let Some(choice) = state.judge_models.get(state.selected_judge_model) else {
        return Ok(());
    };
    save_arc_config(ArcConfigPatch {
        injection_judge_mode: Some("provider-judge".to_owned()),
        injection_judge_model: Some(JudgeModel {
            provider: choice.provider.clone(),
            id: choice.id.clone(),
        }),
        ..ArcConfigPatch::default()
    })?;
    Ok(())
}

fn push_section(lines: &mut Vec<Line<'static>>, title: &'static str, values: &[String]) {
    lines.push(Line::raw(""));
    lines.push(Line::from(Span::styled(
        title,
        Style::default()
            .fg(Color::Cyan)
            .add_modifier(Modifier::BOLD),
    )));
    let values = values
        .iter()
        .filter(|value| !value.trim().is_empty())
        .collect::<Vec<_>>();
    if values.is_empty() {
        lines.push(Line::from(Span::styled(
            "none recorded",
            Style::default().fg(Color::DarkGray),
        )));
        return;
    }
    for (index, value) in values.iter().enumerate() {
        lines.push(Line::from(format!("{}. {}", index + 1, value)));
    }
}

fn pill(value: &str, color: Color) -> Span<'static> {
    Span::styled(
        format!(" {} ", fit_words(&value.replace('_', " "), 18)),
        Style::default().fg(Color::White).bg(color),
    )
}

fn privacy_label(value: &str) -> String {
    match value {
        "local" => "local".to_owned(),
        "local_only" => "local".to_owned(),
        "shareable" => "shareable".to_owned(),
        other => other.replace('_', " "),
    }
}

fn confidence_bar(confidence: u8) -> String {
    let filled = (confidence as usize + 5) / 10;
    format!("[{}{}]", "#".repeat(filled), "-".repeat(10 - filled))
}

fn confidence_color(confidence: u8) -> Color {
    if confidence >= 80 {
        Color::Green
    } else if confidence >= 55 {
        Color::Yellow
    } else {
        Color::Red
    }
}

fn status_color(status: &str) -> Color {
    match status {
        "local" | "shareable" | "shared" => Color::Green,
        "private" | "rejected" => Color::Yellow,
        "superseded" | "disabled" => Color::DarkGray,
        _ => Color::Gray,
    }
}

fn event_color(kind: &str) -> Color {
    if kind == "review.saved"
        || kind == "capsule.created"
        || kind == "capsule.finalized"
        || kind == "capsule.promoted"
    {
        Color::Green
    } else if kind == "privacy_updated"
        || kind == "capsule.privacy_updated"
        || kind == "runner.completed"
        || kind == "turn.started"
    {
        Color::DarkGray
    } else if kind.contains("inject") || kind.contains("prompt") {
        Color::Cyan
    } else if kind.contains("skip") || kind.contains("reject") || kind.contains("abstain") {
        Color::DarkGray
    } else {
        Color::Gray
    }
}

fn event_label(kind: &str) -> String {
    kind.replace('.', " ")
}

fn judge_label(judge: &ArcUiJudgeStatus) -> String {
    let mode = if judge.mode == "provider-judge" {
        "provider"
    } else {
        "embedding"
    };
    let label = judge
        .model
        .as_ref()
        .map(|model| format!("{mode}:{}:{}", model.provider, model.id))
        .unwrap_or_else(|| mode.to_owned());
    if judge.configured_and_unreachable() {
        format!("{label}:unreachable")
    } else {
        label
    }
}

fn fit_words(value: &str, max: usize) -> String {
    let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if value.chars().count() <= max {
        return value;
    }
    if max <= 3 {
        return ".".repeat(max);
    }
    let mut out = String::new();
    for word in value.split_whitespace() {
        let projected = if out.is_empty() {
            word.chars().count()
        } else {
            out.chars().count() + 1 + word.chars().count()
        };
        if projected + 3 > max {
            break;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(word);
    }
    if out.is_empty() {
        value
            .chars()
            .take(max.saturating_sub(3))
            .collect::<String>()
            + "..."
    } else {
        out.push_str("...");
        out
    }
}

fn age(timestamp: &str) -> String {
    let Ok(parsed) = DateTime::parse_from_rfc3339(timestamp) else {
        return String::new();
    };
    let elapsed = Utc::now().signed_duration_since(parsed.with_timezone(&Utc));
    if elapsed.num_days() > 0 {
        format!("{}d", elapsed.num_days())
    } else if elapsed.num_hours() > 0 {
        format!("{}h", elapsed.num_hours())
    } else {
        format!("{}m", elapsed.num_minutes().max(0))
    }
}

#[derive(Default)]
pub(crate) struct UiOptions {
    query: String,
    selected_id: Option<String>,
    event_limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArcUiViewModel {
    status: ArcUiStatus,
    query: String,
    capsules: Vec<ArcUiCapsuleRow>,
    selected_capsule: Option<ArcUiCapsuleRow>,
    declined: Vec<DeclinedDraftView>,
    recent_events: Vec<ArcUiEventRow>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ArcUiStatus {
    repo: String,
    workspace: String,
    cache_dir: String,
    capsule_count: usize,
    declined_count: usize,
    event_count: usize,
    judge: ArcUiJudgeStatus,
    injection_pause: InjectionPauseStatus,
    integration: Option<String>,
    extension: Value,
    hook: Value,
    last_injection: Option<ArcUiEventRow>,
    last_save: Option<ArcUiEventRow>,
    generated_at: String,
}

#[derive(Debug, Clone, Serialize)]
struct ArcUiJudgeStatus {
    mode: String,
    model: Option<JudgeModel>,
    reachability: JudgeReachability,
}

impl ArcUiJudgeStatus {
    fn configured_and_unreachable(&self) -> bool {
        self.reachability.configured && !self.reachability.reachable
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ArcUiCapsuleRow {
    id: String,
    short_id: String,
    title: String,
    summary: String,
    status: String,
    privacy_label: String,
    kind: String,
    confidence: f64,
    updated_at: String,
    use_count: u64,
    reuse_when: Vec<String>,
    do_not_reuse_when: Vec<String>,
    next_run_instruction: String,
    steps: Vec<String>,
    commands: Vec<String>,
    evidence: Vec<String>,
    validation_probe: Vec<String>,
    failed_attempts: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ArcUiEventRow {
    id: String,
    r#type: String,
    timestamp: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    capsule_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    title: String,
    detail: String,
}

pub(crate) fn load_ui_view_model(workspace: &Path, options: UiOptions) -> Result<ArcUiViewModel> {
    let mut capsules = load_capsules(workspace)?;
    let declined = load_declined_draft_views(workspace)?;
    let events = load_memory_events(workspace)?;
    let config = load_arc_config()?;
    let reachability = judge_reachability(&config);
    let injection_pause = injection_pause_status(&config);
    capsules.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    let query = options.query.trim().to_owned();
    let rows = capsules
        .iter()
        .map(capsule_to_row)
        .filter(|row| matches_ui_query(row, &query))
        .collect::<Vec<_>>();
    let selected_capsule = options
        .selected_id
        .as_ref()
        .and_then(|id| rows.iter().find(|row| &row.id == id).cloned())
        .or_else(|| rows.first().cloned());
    let limit = options.event_limit.unwrap_or(80);
    let recent_events = events
        .iter()
        .rev()
        .take(limit)
        .map(event_to_row)
        .collect::<Vec<_>>();
    let last_injection = last_event(&events, "capsule.injected")
        .and_then(|value| serde_json::from_value::<MemoryEvent>(value).ok())
        .map(|event| event_to_row(&event));
    let last_save = last_save_event(&events)
        .and_then(|value| serde_json::from_value::<MemoryEvent>(value).ok())
        .map(|event| event_to_row(&event));
    Ok(ArcUiViewModel {
        status: ArcUiStatus {
            repo: workspace
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("repo")
                .to_owned(),
            workspace: workspace.to_string_lossy().to_string(),
            cache_dir: cache_dir(workspace).to_string_lossy().to_string(),
            capsule_count: capsules.len(),
            declined_count: declined.len(),
            event_count: events.len(),
            judge: ArcUiJudgeStatus {
                mode: config
                    .injection_judge_mode
                    .unwrap_or_else(|| "embedding-only".to_owned()),
                model: config.injection_judge_model,
                reachability,
            },
            injection_pause,
            integration: read_activation_integration(workspace),
            extension: extension_status(workspace),
            hook: hook_status(workspace),
            last_injection,
            last_save,
            generated_at: now_iso(),
        },
        query,
        capsules: rows,
        selected_capsule,
        declined,
        recent_events,
    })
}

fn capsule_to_row(capsule: &Capsule) -> ArcUiCapsuleRow {
    ArcUiCapsuleRow {
        id: capsule.id.clone(),
        short_id: short(&capsule.id, 8),
        title: capsule.title.clone(),
        summary: capsule.summary.clone(),
        status: capsule.status.clone(),
        privacy_label: capsule.privacy_label.clone(),
        kind: capsule.kind.clone(),
        confidence: capsule.confidence,
        updated_at: capsule.updated_at.clone(),
        use_count: capsule.use_count,
        reuse_when: capsule.reuse_when.clone(),
        do_not_reuse_when: capsule.do_not_reuse_when.clone(),
        next_run_instruction: capsule.next_run_instruction.clone(),
        steps: capsule.workflow.steps.clone(),
        commands: capsule.workflow.commands.clone(),
        evidence: capsule.evidence.clone(),
        validation_probe: capsule.workflow.validation_probe.clone(),
        failed_attempts: capsule.workflow.failed_attempts.clone(),
    }
}

fn event_to_row(event: &MemoryEvent) -> ArcUiEventRow {
    let title = event
        .details
        .as_ref()
        .and_then(|details| {
            details
                .get("title")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .or_else(|| {
            event.details.as_ref().and_then(|details| {
                details
                    .get("capsuleIds")
                    .and_then(Value::as_array)
                    .map(|ids| {
                        ids.iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join(",")
                    })
            })
        })
        .or_else(|| event.capsule_id.clone())
        .unwrap_or_default();
    let detail = if !title.is_empty() {
        title.clone()
    } else {
        event
            .details
            .as_ref()
            .and_then(|details| {
                details
                    .get("reason")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .or_else(|| event.session_id.clone())
            .unwrap_or_default()
    };
    ArcUiEventRow {
        id: event.id.clone(),
        r#type: event.r#type.clone(),
        timestamp: event.timestamp.clone(),
        capsule_id: event.capsule_id.clone(),
        session_id: event.session_id.clone(),
        title,
        detail,
    }
}

fn matches_ui_query(row: &ArcUiCapsuleRow, query: &str) -> bool {
    if query.is_empty() {
        return true;
    }
    [
        row.id.clone(),
        row.title.clone(),
        row.summary.clone(),
        row.status.clone(),
        row.privacy_label.clone(),
        row.next_run_instruction.clone(),
        row.reuse_when.join("\n"),
        row.do_not_reuse_when.join("\n"),
    ]
    .join("\n")
    .to_lowercase()
    .contains(&query.to_lowercase())
}

pub(crate) fn render_status_summary(model: &ArcUiViewModel) -> String {
    let seam = if model.status.integration.as_deref() == Some("copilot-plugin") {
        "plugin active"
    } else if model.status.hook["installed"].as_bool().unwrap_or(false) {
        "hook live"
    } else {
        "plugin pending"
    };
    format!(
        "ARC {} | capsules: {} | declined: {} | events: {} | seam: {}{}",
        model.status.repo,
        model.status.capsule_count,
        model.status.declined_count,
        model.status.event_count,
        seam,
        if model.status.injection_pause.paused {
            format!(" | {}", model.status.injection_pause.label)
        } else {
            String::new()
        }
    )
}

fn render_ui_text(model: &ArcUiViewModel) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "ARC · {} capsules · {} events · judge {}{} · {}\n",
        model.status.capsule_count,
        model.status.event_count,
        judge_label(&model.status.judge),
        if model.status.injection_pause.paused {
            format!(" · {}", model.status.injection_pause.label)
        } else {
            String::new()
        },
        model.status.repo
    ));
    out.push_str("1 Capsules  2 Activity  3 Settings\n");
    out.push_str("filter : all capsules\n\n");
    if model.capsules.is_empty() {
        out.push_str(
            "No capsules yet. ARC saves verified reusable methods after successful sessions.\n",
        );
    } else {
        for capsule in model.capsules.iter().take(8) {
            let confidence = (capsule.confidence * 100.0).round().clamp(0.0, 100.0) as u8;
            out.push_str(&format!(
                "● [{}] [{}] {}% {} {}  {}\n  {}\n",
                capsule.kind.replace('_', " "),
                privacy_label(&capsule.privacy_label),
                confidence,
                confidence_bar(confidence),
                age(&capsule.updated_at),
                capsule.title,
                fit_words(&capsule.summary, 90)
            ));
        }
    }
    if let Some(capsule) = &model.selected_capsule {
        out.push_str(&format!("\n{}\n", capsule.title));
        out.push_str(&format!(
            "id {} | uses {} | {}% confidence\n",
            capsule.short_id,
            capsule.use_count,
            (capsule.confidence * 100.0).round() as i64
        ));
        out.push_str("\nSUMMARY\n");
        out.push_str(&format!("1. {}\n", capsule.summary));
        out.push_str("\nREUSE WHEN\n");
        for (index, value) in capsule.reuse_when.iter().take(3).enumerate() {
            out.push_str(&format!("{}. {}\n", index + 1, value));
        }
        out.push_str("\nSTEPS\n");
        for (index, value) in capsule.steps.iter().take(5).enumerate() {
            out.push_str(&format!("{}. {}\n", index + 1, value));
        }
        out.push_str("\nCOMMAND SHAPES\n");
        for (index, value) in capsule.commands.iter().take(4).enumerate() {
            out.push_str(&format!("{}. {}\n", index + 1, value));
        }
    }
    out.push_str("\nACTIVITY\n");
    for event in model.recent_events.iter().take(8) {
        out.push_str(&format!(
            "{}  {}  {}\n",
            event_label(&event.r#type),
            age(&event.timestamp),
            if event.detail.is_empty() {
                event.session_id.clone().unwrap_or_default()
            } else {
                event.detail.clone()
            }
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::backend::TestBackend;

    fn test_model() -> ArcUiViewModel {
        let capsule = ArcUiCapsuleRow {
            id: "capsule-test".to_owned(),
            short_id: "capsule-".to_owned(),
            title: "Reuse the verified release route".to_owned(),
            summary: "Build the native binary, run focused tests, and verify the packaged output."
                .to_owned(),
            status: "active".to_owned(),
            privacy_label: "local".to_owned(),
            kind: "workflow".to_owned(),
            confidence: 0.91,
            updated_at: Utc::now().to_rfc3339(),
            use_count: 2,
            reuse_when: vec!["publishing a native ARC release".to_owned()],
            do_not_reuse_when: vec!["only TypeScript changed".to_owned()],
            next_run_instruction: "Start with the focused Rust tests.".to_owned(),
            steps: vec![
                "build release binary".to_owned(),
                "run smoke check".to_owned(),
            ],
            commands: vec!["cargo test".to_owned(), "npm run build".to_owned()],
            evidence: vec!["all focused tests passed".to_owned()],
            validation_probe: vec!["arc doctor --json".to_owned()],
            failed_attempts: vec!["do not publish an unverified archive".to_owned()],
        };
        ArcUiViewModel {
            status: ArcUiStatus {
                repo: "tracer-ai".to_owned(),
                workspace: "/tmp/tracer-ai".to_owned(),
                cache_dir: "/tmp/tracer-ai/.agent-run-cache".to_owned(),
                capsule_count: 1,
                declined_count: 1,
                event_count: 3,
                judge: ArcUiJudgeStatus {
                    mode: "provider-judge".to_owned(),
                    model: Some(JudgeModel {
                        provider: "ollama".to_owned(),
                        id: "test-judge".to_owned(),
                    }),
                    reachability: JudgeReachability {
                        configured: true,
                        reachable: true,
                        path: Some("built-in-ollama-api".to_owned()),
                        check: "static".to_owned(),
                        reason: "built-in Ollama judge path available; live model not probed"
                            .to_owned(),
                    },
                },
                injection_pause: InjectionPauseStatus {
                    paused: false,
                    paused_until: None,
                    seconds_remaining: None,
                    label: "active".to_owned(),
                },
                integration: Some("copilot-plugin".to_owned()),
                extension: Value::Null,
                hook: Value::Null,
                last_injection: None,
                last_save: None,
                generated_at: now_iso(),
            },
            query: String::new(),
            capsules: vec![capsule.clone()],
            selected_capsule: Some(capsule),
            declined: vec![DeclinedDraftView {
                id: "declined-test".to_owned(),
                merge_key: "draft:declined-test".to_owned(),
                title: "Recover the declined verification route".to_owned(),
                summary: "A completed command had reusable verification evidence.".to_owned(),
                session_id: "declined-session".to_owned(),
                outcome: "success".to_owned(),
                reason: "reviewer considered this one-off".to_owned(),
                created_at: Utc::now().to_rfc3339(),
                age_seconds: 60,
            }],
            recent_events: vec![ArcUiEventRow {
                id: "event-test".to_owned(),
                r#type: "capsule.injected".to_owned(),
                timestamp: Utc::now().to_rfc3339(),
                capsule_id: Some("capsule-test".to_owned()),
                session_id: Some("session-test".to_owned()),
                title: "injected".to_owned(),
                detail: "verified release route".to_owned(),
            }],
        }
    }

    fn terminal_text(terminal: &Terminal<TestBackend>) -> String {
        let buffer = terminal.backend().buffer();
        (0..buffer.area.height)
            .map(|y| {
                (0..buffer.area.width)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn narrow_summary_is_mouse_navigable() {
        let model = test_model();
        let state = InteractiveUiState::default();
        let backend = TestBackend::new(40, 18);
        let mut terminal = Terminal::new(backend).unwrap();
        let mut hit_regions = Vec::new();
        terminal
            .draw(|frame| draw_ui_frame(frame, &model, &state, &mut hit_regions))
            .unwrap();

        let text = terminal_text(&terminal);
        assert!(text.contains("arc · tracer-ai"));
        assert!(text.contains("capsules"));
        assert!(text.contains("declined"));
        assert!(text.contains("injection"));
        for row in 0..5 {
            assert!(hit_regions.iter().any(|region| {
                matches!(
                    &region.action,
                    UiAction::OpenSummaryRow(index) if *index == row
                )
            }));
        }
    }

    #[test]
    fn narrow_detail_has_folded_sections_and_exact_copy_targets() {
        let model = test_model();
        let mut state = InteractiveUiState {
            narrow_screen: NarrowScreen::CapsuleDetail,
            ..InteractiveUiState::default()
        };
        state.expanded_sections.insert(DetailSection::Commands);
        let backend = TestBackend::new(40, 26);
        let mut terminal = Terminal::new(backend).unwrap();
        let mut hit_regions = Vec::new();
        terminal
            .draw(|frame| draw_ui_frame(frame, &model, &state, &mut hit_regions))
            .unwrap();

        let text = terminal_text(&terminal);
        for label in [
            "reuse when",
            "steps",
            "commands",
            "evidence",
            "avoid when",
            "validation",
            "dead ends",
            "full",
            "copy",
        ] {
            assert!(text.contains(label), "missing {label} in:\n{text}");
        }

        let section_copy = hit_regions
            .iter()
            .find(|region| {
                matches!(
                    &region.action,
                    UiAction::CopySection(DetailSection::Commands)
                )
            })
            .expect("commands section copy target");
        assert_eq!(section_copy.area.width, 2);
        assert!(hit_regions.iter().any(|region| {
            region.area.y == section_copy.area.y
                && region.area.width == 40
                && matches!(
                    &region.action,
                    UiAction::ToggleSection(DetailSection::Commands)
                )
        }));

        let copied =
            copy_text_for_action(&UiAction::CopyCommand(0), &model, &state, Path::new("/tmp"))
                .unwrap();
        assert_eq!(copied.as_deref(), Some("cargo test"));
    }

    #[test]
    fn narrow_keyboard_follows_the_same_navigation_actions() {
        use crossterm::event::KeyCode;

        let model = test_model();
        let mut state = InteractiveUiState::default();
        assert!(matches!(
            handle_narrow_key(KeyCode::Enter, &model, &mut state).unwrap(),
            NarrowKeyOutcome::Action(UiAction::OpenSummaryRow(0))
        ));

        state.narrow_screen = NarrowScreen::Capsules;
        assert!(matches!(
            handle_narrow_key(KeyCode::Enter, &model, &mut state).unwrap(),
            NarrowKeyOutcome::Action(UiAction::OpenCapsule(0))
        ));

        state.narrow_screen = NarrowScreen::CapsuleDetail;
        assert!(matches!(
            handle_narrow_key(KeyCode::Enter, &model, &mut state).unwrap(),
            NarrowKeyOutcome::Action(UiAction::ToggleSection(DetailSection::ReuseWhen))
        ));

        state.narrow_screen = NarrowScreen::Declined;
        assert!(matches!(
            handle_narrow_key(KeyCode::Enter, &model, &mut state).unwrap(),
            NarrowKeyOutcome::Action(UiAction::PromoteDeclined(0))
        ));
    }

    #[test]
    fn split_appliance_cannot_self_close_the_arc_pane() {
        use crossterm::event::KeyCode;

        let model = test_model();
        let mut state = InteractiveUiState {
            appliance: true,
            ..InteractiveUiState::default()
        };
        // The ARC pane is a companion viewer with no independent close: it lives
        // until Copilot exits and closes the whole split. No key closes it, so a
        // stray q/esc/f can't kill the pane.
        for key in [KeyCode::Char('q'), KeyCode::Esc, KeyCode::Char('f')] {
            assert!(matches!(
                handle_narrow_key(key, &model, &mut state).unwrap(),
                NarrowKeyOutcome::Continue
            ));
        }

        let backend = TestBackend::new(80, 22);
        let mut terminal = Terminal::new(backend).unwrap();
        let mut hit_regions = Vec::new();
        terminal
            .draw(|frame| draw_ui_frame(frame, &model, &state, &mut hit_regions))
            .unwrap();
        let text = terminal_text(&terminal);
        assert!(!text.contains("close by exiting Copilot"));
        assert!(!hit_regions
            .iter()
            .any(|region| matches!(&region.action, UiAction::ToggleZoom)));

        state.narrow_screen = NarrowScreen::CapsuleDetail;
        hit_regions.clear();
        terminal
            .draw(|frame| draw_ui_frame(frame, &model, &state, &mut hit_regions))
            .unwrap();
        let text = terminal_text(&terminal);
        assert!(text.contains("‹ back · copy"));
        assert!(!text.contains("full"));
        assert!(!hit_regions
            .iter()
            .any(|region| matches!(&region.action, UiAction::ToggleZoom)));
    }

    // WS2: ReloadThrottle — reload is forced on first call, then throttled.
    #[test]
    fn reload_throttle_forces_first_reload() {
        let mut throttle = ReloadThrottle::new(Duration::from_millis(500));
        let now = Instant::now();
        assert!(
            throttle.should_reload(now),
            "first cycle must always reload"
        );
        throttle.mark_reloaded(now);
        assert!(
            !throttle.should_reload(now),
            "immediately after reload, should not reload again"
        );
    }

    #[test]
    fn reload_throttle_reloads_after_interval() {
        let interval = Duration::from_millis(500);
        let mut throttle = ReloadThrottle::new(interval);
        let t0 = Instant::now();
        throttle.mark_reloaded(t0);

        assert!(!throttle.should_reload(t0 + Duration::from_millis(499)));
        assert!(
            throttle.should_reload(t0 + Duration::from_millis(500)),
            "reload must fire once the throttle interval has elapsed"
        );
    }

    #[test]
    fn reload_throttle_force_bypasses_interval() {
        let mut throttle = ReloadThrottle::new(Duration::from_millis(500));
        let t0 = Instant::now();
        throttle.mark_reloaded(t0);

        assert!(!throttle.should_reload(t0));
        throttle.force_reload();
        assert!(
            throttle.should_reload(t0),
            "force_reload must bypass the throttle interval"
        );
        throttle.mark_reloaded(t0);
        assert!(
            !throttle.should_reload(t0),
            "mark_reloaded must clear the force flag"
        );
    }

    // WS2: should_log_slow_frame — only logs above threshold and rate-limited.
    #[test]
    fn slow_frame_logs_above_threshold_and_rate_limit() {
        let threshold = Duration::from_millis(100);
        let min_interval = Duration::from_secs(60);

        assert!(
            should_log_slow_frame(
                Duration::from_millis(150),
                threshold,
                Duration::from_secs(61),
                min_interval,
            ),
            "slow cycle past threshold and rate limit should log"
        );
    }

    #[test]
    fn slow_frame_skips_below_threshold() {
        let threshold = Duration::from_millis(100);
        let min_interval = Duration::from_secs(60);

        assert!(
            !should_log_slow_frame(
                Duration::from_millis(80),
                threshold,
                Duration::from_secs(120),
                min_interval,
            ),
            "fast cycle must not log even if rate limit is satisfied"
        );
    }

    #[test]
    fn slow_frame_respects_rate_limit() {
        let threshold = Duration::from_millis(100);
        let min_interval = Duration::from_secs(60);

        assert!(
            !should_log_slow_frame(
                Duration::from_millis(200),
                threshold,
                Duration::from_millis(30),
                min_interval,
            ),
            "must not spam: a slow frame within the rate-limit window is suppressed"
        );
    }
}
