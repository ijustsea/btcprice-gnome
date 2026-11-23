import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {panelText, statusText, type PriceView} from './price.js';

export interface IndicatorActions {
    refresh(): void;
    openChart(): void;
}

export class PriceIndicator {
    readonly button = new PanelMenu.Button(0.5, 'BTC Price');
    // GNOME's default font already has fixed-width digits (measured); the tnum style keeps the
    // width steady for fonts whose digits are proportional by default.
    private label = new St.Label({text: 'BTC —', y_align: Clutter.ActorAlign.CENTER, style_class: 'btcprice-label'});
    private status: PopupMenu.PopupMenuItem;

    constructor(actions: IndicatorActions) {
        this.label.clutter_text.use_markup = false;
        this.button.add_child(this.label);
        if (!(this.button.menu instanceof PopupMenu.PopupMenu)) throw new Error('BTC Price menu unavailable');
        const menu = this.button.menu;
        this.status = new PopupMenu.PopupMenuItem('가격 확인 중…', {reactive: false, can_focus: false});
        this.status.label.clutter_text.use_markup = false;
        this.status.label.add_style_class_name('btcprice-status');
        menu.addMenuItem(this.status);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const refresh = new PopupMenu.PopupMenuItem('지금 새로고침');
        refresh.connect('activate', () => actions.refresh());
        menu.addMenuItem(refresh);
        const chart = new PopupMenu.PopupMenuItem('TradingView 차트 열기 ↗');
        chart.connect('activate', () => actions.openChart());
        menu.addMenuItem(chart);
    }

    update(view: PriceView, now: number): void {
        const text = panelText(view, now);
        if (this.label.get_text() !== text) this.label.set_text(text);
        this.button.accessible_name = text;
        const status = statusText(view);
        if (this.status.label.get_text() !== status) this.status.label.set_text(status);
    }

    destroy(): void {
        this.button.destroy();
    }
}
