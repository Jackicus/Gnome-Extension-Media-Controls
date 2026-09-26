// The audio-and-subtitles pop-out: the shell's own PopupMenu, standing on the
// bar and pointing down at its tracks button, holding the player's audio and
// subtitle tracks as radio lists, the subtitle timing as a − / + row, and the
// chapters when the file has any. Everything in it comes from, and goes to,
// a VlcRemote (vlcremote.js).
//
// Picking a track leaves the menu open, so the audio and the subtitles can be
// chosen in one go from across a room; Escape, the pad's back button or a
// click away closes it.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {SUBTITLE_SHIFT_MS} from './actions.js';
import {PausedError} from './vlcremote.js';

// NO_DOT keeps an unpicked radio item lined up with the picked one's dot.
const PICKED = PopupMenu.Ornament.DOT;
const UNPICKED = PopupMenu.Ornament.NO_DOT ?? PopupMenu.Ornament.NONE;

function formatDelay(ms) {
    if (!ms)
        return '0.0 s';
    const sign = ms > 0 ? '+' : '−';
    return `${sign}${(Math.abs(ms) / 1000).toFixed(ms % 100 ? 2 : 1)} s`;
}

// A menu row holding a label and a few buttons. The row itself is never
// the thing activated; its buttons are, and the menu's focus group walks
// between them with the arrow keys like any other items.
const ButtonRow = GObject.registerClass(
class ButtonRow extends PopupMenu.PopupBaseMenuItem {
    _init(title) {
        super._init({activate: false, hover: false, can_focus: false, style_class: 'mc-menu-row'});
        this.label = new St.Label({
            text: title,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this.label);
        this.label_actor = this.label;
    }

    // The size setting's icon size (bar.js), for every button in the row.
    setIconSize(size) {
        for (const child of this.get_children()) {
            if (child instanceof St.Button && child.child instanceof St.Icon)
                child.child.icon_size = size;
        }
    }

    addButton(iconName, accessibleName, onClick) {
        const button = new St.Button({
            style_class: 'icon-button mc-menu-button',
            icon_name: iconName,
            accessible_name: accessibleName,
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        button.connect('clicked', onClick);
        this.add_child(button);
        return button;
    }

    addValue() {
        const value = new St.Label({style_class: 'mc-menu-value', y_align: Clutter.ActorAlign.CENTER});
        this.add_child(value);
        return value;
    }
});

export class TracksMenu extends PopupMenu.PopupMenu {
    // The menu's source is the whole panel, so it stands above the bar rather
    // than over its top row; the arrow is aimed at `button` as it opens.
    constructor(panel, button) {
        super(panel, 0.5, St.Side.BOTTOM);
        this._button = button;
        this.actor.add_style_class_name('mc-tracks-menu');
        Main.uiGroup.add_child(this.actor);
        this.actor.hide();

        this._remote = null;
        this._audioItems = new Map();
        this._subtitleItems = new Map();

        this._audio = new PopupMenu.PopupMenuSection();
        this._subtitles = new PopupMenu.PopupMenuSection();
        // An item in a section closes the menu through the section's own
        // itemActivated, so it is kept open there too.
        this._audio.itemActivated = this._subtitles.itemActivated = () => {};
        this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Audio'));
        this.addMenuItem(this._audio);
        this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Subtitles'));
        this.addMenuItem(this._subtitles);

        this._sync = new ButtonRow('Timing');
        this._sync.addButton('list-remove-symbolic', 'Subtitles earlier',
            () => this._remote?.shiftSubtitles(-SUBTITLE_SHIFT_MS));
        this._delay = this._sync.addValue();
        this._sync.addButton('list-add-symbolic', 'Subtitles later',
            () => this._remote?.shiftSubtitles(SUBTITLE_SHIFT_MS));
        this._sync.addButton('edit-undo-symbolic', 'Reset subtitle timing',
            () => this._remote?.resetSubtitles());
        this.addMenuItem(this._sync);

        this._chapterSeparator = new PopupMenu.PopupSeparatorMenuItem('Chapters');
        this.addMenuItem(this._chapterSeparator);
        this._chapters = new ButtonRow('');
        this._chapters.addButton('go-previous-symbolic', 'Previous chapter', () => this._chapter(-1));
        this._chapters.addButton('go-next-symbolic', 'Next chapter', () => this._chapter(1));
        this.addMenuItem(this._chapters);
    }

    // Picking a track keeps the menu open (see the top of the file).
    itemActivated() {
    }

    setIconSize(size) {
        this._sync.setIconSize(size);
        this._chapters.setIconSize(size);
    }

    setRemote(remote) {
        this._remote?.disconnectObject(this);
        this._remote = remote;
        this._remote?.connectObject('changed', () => this._syncDelay(), this);
        if (!remote)
            this.close();
    }

    // Read what the player has now, and open onto it. With `focus`, the
    // current audio track takes the keyboard (the bar was opened with the
    // keyboard or the pad).
    async openFresh({focus = false} = {}) {
        const remote = this._remote;
        if (!remote)
            return;
        let state;
        try {
        // The bar may have gone, or the player with it, while VLC was asked.
        if (this._remote !== remote || !this.sourceActor.mapped)
            return;
            state = await remote.state();
        } catch (e) {
            if (!(e instanceof PausedError))
                return;
            // Paused before VLC was ever asked: say why the lists are empty.
            state = {audio: null, subtitles: null, chapter: {current: 0, count: 0}};
        }
        this._fill(state);
        this._aim();
        this.open(BoxPointer.PopupAnimation.FULL);
        if (focus) {
            const current = state.audio?.find(t => t.current);
            (this._audioItems.get(current?.id) ?? [...this._audioItems.values()][0])?.grab_key_focus();
        }
    }

    _fill({audio, subtitles, chapter}) {
        const unread = 'Play for a moment: VLC lists its tracks only while playing';
        this._fillList(this._audio, this._audioItems, audio?.filter(t => t.id !== -1) ?? [],
            audio ? 'No audio tracks' : unread, id => this._remote?.setAudio(id).catch(() => {}));
        this._fillList(this._subtitles, this._subtitleItems, subtitles ?? [],
            subtitles ? 'No subtitles' : unread, id => this._remote?.setSubtitles(id).catch(() => {}));
        // Only Off, or unknown: nothing to time.
        this._sync.visible = !!subtitles?.some(t => t.id !== -1);
        this._syncDelay();
        const hasChapters = chapter.count > 1;
        this._chapterSeparator.visible = this._chapters.visible = hasChapters;
        this._chapterState = chapter;
        this._syncChapter();
    }

    _fillList(section, items, tracks, empty, choose) {
        section.removeAll();
        items.clear();
        if (!tracks.length) {
            section.addMenuItem(new PopupMenu.PopupMenuItem(empty, {reactive: false}));
            return;
        }
        for (const track of tracks) {
            const item = new PopupMenu.PopupMenuItem(track.label);
            item.setOrnament(track.current ? PICKED : UNPICKED);
            item.connect('activate', () => {
                for (const other of items.values())
                    other.setOrnament(other === item ? PICKED : UNPICKED);
                choose(track.id);
            });
            section.addMenuItem(item);
            items.set(track.id, item);
        }
    }

    // Point the arrow at the tracks button: the fraction of the panel's
    // content width its middle sits at, as BoxPointer measures its source.
    _aim() {
        const panel = this.sourceActor;
        const [panelX] = panel.get_transformed_position();
        const [buttonX] = this._button.get_transformed_position();
        const [buttonWidth] = this._button.get_transformed_size();
        const content = panel.get_theme_node().get_content_box(panel.get_allocation_box());
        const width = content.x2 - content.x1;
        if (width > 0)
            this.setSourceAlignment(Math.clamp((buttonX + buttonWidth / 2 - panelX - content.x1) / width, 0, 1));
    }

    _syncDelay() {
        this._delay.text = formatDelay(this._remote?.subtitleDelay ?? 0);
    }

    _syncChapter() {
        const {current, count} = this._chapterState ?? {current: 0, count: 0};
        // VLC counts chapters from 0.
        this._chapters.label.text = `Chapter ${current + 1} of ${count}`;
    }

    async _chapter(delta) {
        try {
            const chapter = await this._remote?.chapter(delta);
            if (chapter) {
                this._chapterState = chapter;
                this._syncChapter();
            }
        } catch (e) {
            // The player went; the menu goes with the bar.
        }
    }

    destroy() {
        this.setRemote(null);
        super.destroy();
    }
}
