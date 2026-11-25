import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {isLive, menuPrice, panelText, sourceName, statusText, type PriceView} from './price.js';

export interface IndicatorActions {
    refresh(): void;
    openChart(): void;
}

function plainLabel(text: string, style: string): St.Label {
    const label = new St.Label({text, style_class: style, y_align: Clutter.ActorAlign.CENTER});
    label.clutter_text.use_markup = false;
    return label;
}

function setText(label: St.Label, text: string): void {
    if (label.get_text() !== text) label.set_text(text);
}

function actionButton(label: string, name: string, onClick: () => void): St.Button {
    const button = new St.Button({label, accessible_name: name, x_expand: true, can_focus: true, style_class: 'btcprice-action'});
    button.connect('clicked', onClick);
    return button;
}

export class PriceIndicator {
    readonly button = new PanelMenu.Button(0.5, 'BTC Price');
    // GNOME's default font already has fixed-width digits (measured); the tnum style keeps the
    // width steady for fonts whose digits are proportional by default.
    private label = plainLabel('BTC —', 'btcprice-label');
    private source = plainLabel('', 'btcprice-source');
    private price = plainLabel('—', 'btcprice-price');
    private status = plainLabel('가격 확인 중…', 'btcprice-status');

    constructor(actions: IndicatorActions) {
        this.button.add_child(this.label);
        if (!(this.button.menu instanceof PopupMenu.PopupMenu)) throw new Error('BTC Price menu unavailable');
        const menu = this.button.menu;
        menu.actor.add_style_class_name('btcprice-menu');
        const header = new St.BoxLayout({style_class: 'btcprice-header'});
        header.add_child(plainLabel('Bitcoin', 'btcprice-title'));
        header.add_child(new St.Widget({x_expand: true}));
        this.source.visible = false;
        header.add_child(this.source);
        // Buttons rather than menu items: Refresh keeps the menu open, so the new price appears in place.
        const buttons = new St.BoxLayout({style_class: 'btcprice-actions'});
        buttons.add_child(actionButton('Refresh', 'Refresh price', () => actions.refresh()));
        buttons.add_child(actionButton('TradingView chart ↗', 'Open TradingView chart', () => { menu.close(); actions.openChart(); }));
        const card = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, style_class: 'btcprice-card'});
        for (const child of [header, this.price, this.status, buttons]) card.add_child(child);
        // A section, not a non-reactive menu item: GNOME draws those as inactive, which would dim the card.
        const section = new PopupMenu.PopupMenuSection();
        section.actor.add_child(card);
        menu.addMenuItem(section);
    }

    update(view: PriceView, now: number): void {
        const text = panelText(view, now);
        setText(this.label, text);
        this.button.accessible_name = text;
        this.source.visible = view.quote !== null;
        if (view.quote) setText(this.source, sourceName(view.quote.source));
        setText(this.price, menuPrice(view));
        this.price.opacity = isLive(view, now) ? 255 : 150;
        setText(this.status, statusText(view, now));
    }

    destroy(): void {
        this.button.destroy();
    }
}
