import { CONTEXT_MENU_SLOT_NAME, CONTEXT_MENU_TRIGGER_TYPE, HEADER_SLOT_NAME } from "../constants.js";
import { createFileTreeIconResolver } from "./iconResolver.js";
import { FILE_TREE_DEFAULT_ITEM_HEIGHT, FILE_TREE_DEFAULT_OVERSCAN, FILE_TREE_DEFAULT_VIEWPORT_HEIGHT } from "../model/virtualization.js";
import { FILE_TREE_RENAME_VIEW } from "../model/FileTreeController.js";
import { Icon } from "../components/Icon.js";
import { MiddleTruncate, Truncate } from "../components/OverflowText.js";
import { computeFileTreeLayout, computeStickyRows } from "../model/layout.js";
import { GIT_STATUS_DESCENDANT_TITLE, GIT_STATUS_LABEL, GIT_STATUS_TITLE } from "../utils/gitStatusPresentation.js";
import { focusElement, getActiveTreeElement, getCachedViewportHeight, getParkedFocusedRowOffset, getResizeObserverViewportHeight, readMeasuredViewportHeight, scrollFocusedRowIntoView, scrollFocusedRowToOffset, scrollFocusedRowToViewportOffset } from "./focusHelpers.js";
import { classifyFileTreeRenameHandoff } from "./renameHandoff.js";
import { RenameInput } from "./RenameInput.js";
import { computeFileTreeRowElementAttributes } from "./rowAttributes.js";
import { computeFileTreeRowClickPlan } from "./rowClickPlan.js";
import { Fragment } from "preact";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { jsx, jsxs } from "preact/jsx-runtime";

//#region src/render/FileTreeView.tsx
function formatFlattenedSegments(row, renameInput = null, dragTargetFlattenedSegmentPath = null) {
	"use no memo";
	const segments = row.flattenedSegments;
	if (segments == null || segments.length === 0) return renameInput ?? row.name;
	return /* @__PURE__ */ jsx("span", {
		"data-item-flattened-subitems": true,
		children: segments.map((segment, index) => {
			const isLast = index === segments.length - 1;
			return /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx("span", {
				"data-item-flattened-subitem": segment.path,
				"data-item-flattened-subitem-drag-target": dragTargetFlattenedSegmentPath === segment.path ? "true" : void 0,
				children: isLast && renameInput != null ? renameInput : /* @__PURE__ */ jsx(Truncate, { children: segment.name })
			}), index < segments.length - 1 ? " / " : ""] }, segment.path);
		})
	});
}
function getFileTreeRowPath(row) {
	return row.isFlattened ? row.flattenedSegments?.findLast((segment) => segment.isTerminal)?.path ?? row.path : row.path;
}
function getFileTreeRowAriaLabel(row) {
	const flattenedSegments = row.flattenedSegments;
	if (flattenedSegments == null || flattenedSegments.length === 0) return row.name;
	return flattenedSegments.map((segment) => segment.name).join(" / ");
}
function computeStickyRowsFromCandidates(candidates, scrollTop, itemHeight, totalRowCount) {
	return candidates.map((candidate, slotDepth) => {
		const defaultTop = slotDepth * itemHeight;
		const nextBoundaryIndex = candidate.subtreeEndIndex + 1;
		if (nextBoundaryIndex >= totalRowCount) return {
			row: candidate.row,
			top: defaultTop
		};
		const nextBoundaryTop = nextBoundaryIndex * itemHeight - scrollTop;
		return {
			row: candidate.row,
			top: Math.min(defaultTop, nextBoundaryTop - itemHeight)
		};
	}).filter((entry) => entry.top + itemHeight > 0);
}
function computeFileTreeViewLayoutState({ controller, itemHeight, overscan, scrollTop, stickyFolders, viewportHeight }) {
	const visibleCount = controller.getVisibleCount();
	const stickyCandidates = stickyFolders && visibleCount > 0 ? controller.getStickyRowCandidates(scrollTop, itemHeight) : [];
	const visibleRows = stickyCandidates == null && stickyFolders && visibleCount > 0 ? controller.getVisibleRows(0, visibleCount - 1) : [];
	const snapshot = computeFileTreeLayout(visibleRows, {
		itemHeight,
		overscan,
		scrollTop,
		stickyRows: stickyCandidates == null ? void 0 : computeStickyRowsFromCandidates(stickyCandidates, scrollTop, itemHeight, visibleCount),
		totalRowCount: visibleCount,
		viewportHeight
	});
	const previewStickyCandidates = stickyFolders && scrollTop <= 0 && visibleCount > 0 ? controller.getStickyRowCandidates(1, itemHeight) : [];
	const overlayRows = previewStickyCandidates != null && scrollTop <= 0 ? computeStickyRowsFromCandidates(previewStickyCandidates, 1, itemHeight, visibleCount) : stickyFolders && scrollTop <= 0 && visibleRows.length > 0 ? computeStickyRows(visibleRows, 1, itemHeight) : snapshot.sticky.rows;
	return {
		overlayHeight: overlayRows.reduce((maxBottom, entry) => Math.max(maxBottom, entry.top + itemHeight), 0),
		overlayRows,
		snapshot,
		visibleRows
	};
}
const TOUCH_LONG_PRESS_DELAY = 400;
const TOUCH_LONG_PRESS_MOVE_THRESHOLD = 10;
const DRAG_EDGE_SCROLL_THRESHOLD = 40;
const DRAG_EDGE_SCROLL_MAX_SPEED = 18;
function getPointElement(rootNode, clientX, clientY) {
	const pointRoot = rootNode;
	const documentElementFromPoint = document.elementFromPoint?.bind(document) ?? null;
	const element = pointRoot.elementFromPoint?.(clientX, clientY) ?? documentElementFromPoint?.(clientX, clientY) ?? null;
	if (rootNode instanceof ShadowRoot && (element == null || !rootNode.contains(element))) return getShadowPointElementByGeometry(rootNode, clientX, clientY);
	return element instanceof HTMLElement ? element : null;
}
function getShadowPointElementByGeometry(rootNode, clientX, clientY) {
	const candidates = Array.from(rootNode.querySelectorAll("[data-type=\"item\"], [data-item-flattened-subitem]"));
	for (let index = candidates.length - 1; index >= 0; index--) {
		const candidate = candidates[index];
		const rect = candidate.getBoundingClientRect();
		if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) return candidate;
	}
	return null;
}
function resolveDropTargetFromElement(target) {
	const rowButton = target?.closest?.("[data-type=\"item\"]");
	if (!(rowButton instanceof HTMLElement)) return null;
	const hoveredPath = rowButton.dataset.itemPath ?? null;
	if (hoveredPath == null) return null;
	const flattenedSegment = target?.closest?.("[data-item-flattened-subitem]");
	const flattenedSegmentPath = flattenedSegment instanceof HTMLElement ? flattenedSegment.getAttribute("data-item-flattened-subitem") ?? null : null;
	if (flattenedSegmentPath != null && flattenedSegmentPath.endsWith("/")) return {
		directoryPath: flattenedSegmentPath,
		flattenedSegmentPath,
		hoveredPath,
		kind: "directory"
	};
	if (rowButton.dataset.itemType === "folder") return {
		directoryPath: hoveredPath,
		flattenedSegmentPath: null,
		hoveredPath,
		kind: "directory"
	};
	const parentPath = rowButton.dataset.itemParentPath ?? null;
	if (parentPath == null || parentPath.length === 0) return {
		directoryPath: null,
		flattenedSegmentPath: null,
		hoveredPath,
		kind: "root"
	};
	return {
		directoryPath: parentPath,
		flattenedSegmentPath: null,
		hoveredPath,
		kind: "directory"
	};
}
function createDragPreviewElement(sourceElement) {
	const preview = sourceElement.cloneNode(true);
	preview.removeAttribute("id");
	preview.dataset.fileTreeDragPreview = "true";
	preview.setAttribute("aria-hidden", "true");
	preview.tabIndex = -1;
	Object.assign(preview.style, {
		boxShadow: "0 4px 12px rgba(0, 0, 0, 0.15)",
		left: "0px",
		margin: "0",
		pointerEvents: "none",
		position: "fixed",
		top: "0px",
		willChange: "transform",
		zIndex: "10000"
	});
	return preview;
}
function shouldUseCustomPointerDragImage() {
	return navigator.vendor !== "Apple Computer, Inc.";
}
function getDragEdgeScrollDelta(clientY, scrollRect) {
	const topDistance = clientY - scrollRect.top;
	if (topDistance < DRAG_EDGE_SCROLL_THRESHOLD) {
		const clampedDistance = Math.max(0, topDistance);
		return -Math.ceil((DRAG_EDGE_SCROLL_THRESHOLD - clampedDistance) / DRAG_EDGE_SCROLL_THRESHOLD * DRAG_EDGE_SCROLL_MAX_SPEED);
	}
	const bottomDistance = scrollRect.bottom - clientY;
	if (bottomDistance < DRAG_EDGE_SCROLL_THRESHOLD) {
		const clampedDistance = Math.max(0, bottomDistance);
		return Math.ceil((DRAG_EDGE_SCROLL_THRESHOLD - clampedDistance) / DRAG_EDGE_SCROLL_THRESHOLD * DRAG_EDGE_SCROLL_MAX_SPEED);
	}
	return 0;
}
function getBuiltInGitStatusDecoration(gitStatus, containsGitChange) {
	if (gitStatus != null) {
		const label = GIT_STATUS_LABEL[gitStatus];
		if (label == null) return null;
		return {
			text: label,
			title: GIT_STATUS_TITLE[gitStatus]
		};
	}
	if (containsGitChange) return {
		icon: {
			name: "file-tree-icon-dot",
			width: 6,
			height: 6
		},
		title: GIT_STATUS_DESCENDANT_TITLE
	};
	return null;
}
function getInheritedIgnoredGitStatus(ancestorPaths, ignoredDirectoryPaths, ignoredInheritanceCache) {
	if (ignoredDirectoryPaths == null || ignoredDirectoryPaths.size === 0) return null;
	const visitedAncestors = [];
	for (let index = ancestorPaths.length - 1; index >= 0; index -= 1) {
		const ancestorPath = ancestorPaths[index];
		const cached = ignoredInheritanceCache.get(ancestorPath);
		if (cached != null) {
			for (const visitedAncestor of visitedAncestors) ignoredInheritanceCache.set(visitedAncestor, cached);
			return cached ? "ignored" : null;
		}
		if (ignoredDirectoryPaths.has(ancestorPath)) {
			ignoredInheritanceCache.set(ancestorPath, true);
			for (const visitedAncestor of visitedAncestors) ignoredInheritanceCache.set(visitedAncestor, true);
			return "ignored";
		}
		visitedAncestors.push(ancestorPath);
	}
	for (const visitedAncestor of visitedAncestors) ignoredInheritanceCache.set(visitedAncestor, false);
	return null;
}
function isFileTreeDirectoryHandle(item) {
	return item != null && "toggle" in item;
}
function isSpaceSelectionKey(event) {
	return event.code === "Space" || event.key === " " || event.key === "Spacebar";
}
function isSearchOpenSeedKey(event) {
	return event.key.length === 1 && /^[\p{L}\p{N}]$/u.test(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey;
}
function getFileTreeGuideStyleText(focusedParentPath) {
	if (focusedParentPath == null) return "";
	return `[data-item-section="spacing-item"][data-ancestor-path="${focusedParentPath.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"] { opacity: 1; }`;
}
function isContextMenuOpenKey(event) {
	return event.shiftKey && event.key === "F10" || event.key === "ContextMenu";
}
function canKeyUseStickyKeyboardState(event, contextMenuEnabled) {
	if (contextMenuEnabled && isContextMenuOpenKey(event)) return true;
	if ((event.ctrlKey || event.metaKey) && isSpaceSelectionKey(event)) return true;
	return event.key === "ArrowDown" || event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "ArrowUp";
}
const BLOCKED_CONTEXT_MENU_NAV_KEYS = new Set([
	"ArrowDown",
	"ArrowLeft",
	"ArrowRight",
	"ArrowUp",
	"End",
	"Home",
	"PageDown",
	"PageUp"
]);
function isEventInContextMenu(event) {
	for (const entry of event.composedPath()) {
		if (!(entry instanceof HTMLElement)) continue;
		if (entry.dataset.fileTreeContextMenuRoot === "true") return true;
		if (entry.dataset.type === "context-menu-anchor" || entry.dataset.type === CONTEXT_MENU_TRIGGER_TYPE) return true;
		if (entry.getAttribute("slot") === CONTEXT_MENU_SLOT_NAME) return true;
	}
	return false;
}
function serializeAnchorRect(rect) {
	return {
		bottom: rect.bottom,
		height: rect.height,
		left: rect.left,
		right: rect.right,
		top: rect.top,
		width: rect.width,
		x: rect.x,
		y: rect.y
	};
}
function createAnchorRectFromPoint(x, y) {
	return {
		bottom: y,
		height: 0,
		left: x,
		right: x,
		top: y,
		width: 0,
		x,
		y
	};
}
function getContextMenuAnchorTop(rootElement, itemElement) {
	if (rootElement == null) return itemElement.offsetTop;
	const itemRect = itemElement.getBoundingClientRect();
	const rootRect = rootElement.getBoundingClientRect();
	return itemRect.top - rootRect.top;
}
function setButtonRef(buttonRefs, path, element) {
	if (element == null) {
		buttonRefs.delete(path);
		return;
	}
	buttonRefs.set(path, element);
}
function getContextMenuAnchorButton(path, stickyButtonRefs, rowButtonRefs) {
	if (path == null) return null;
	const stickyButton = stickyButtonRefs.get(path) ?? null;
	if (stickyButton != null) return stickyButton;
	const rowButton = rowButtonRefs.get(path) ?? null;
	return rowButton?.dataset.itemParked === "true" ? null : rowButton;
}
function getMountedStickyRowPaths(rootElement) {
	if (rootElement == null) return [];
	const paths = [];
	for (const element of rootElement.querySelectorAll("button[data-file-tree-sticky-row=\"true\"]")) {
		if (!(element instanceof HTMLElement)) continue;
		const path = element.dataset.fileTreeStickyPath;
		if (path != null) paths.push(path);
	}
	return paths;
}
function getFocusedParkedRowElement(rootElement, path) {
	if (rootElement == null || path == null) return null;
	for (const element of rootElement.querySelectorAll("button[data-item-focused=\"true\"][data-item-parked=\"true\"]")) if (element instanceof HTMLElement && element.dataset.itemPath === path) return element;
	return null;
}
function getStickyKeyboardViewportOffset(rootElement, scrollElement, activeTreeElement, path, itemHeight, stickyOverlayHeight, viewportHeight) {
	const minimumStickyKeyboardViewportOffset = Math.max(0, stickyOverlayHeight - itemHeight);
	const scrollElementRect = scrollElement?.getBoundingClientRect() ?? null;
	const activeElementTopWithinViewport = scrollElementRect == null || activeTreeElement == null ? null : activeTreeElement.getBoundingClientRect().top - scrollElementRect.top;
	const focusedParkedRowElement = getFocusedParkedRowElement(rootElement, path);
	const parkedElementTopWithinViewport = scrollElementRect == null || focusedParkedRowElement == null ? null : focusedParkedRowElement.getBoundingClientRect().top - scrollElementRect.top;
	return Math.max(0, Math.min(parkedElementTopWithinViewport ?? Math.max(activeElementTopWithinViewport ?? 0, minimumStickyKeyboardViewportOffset), Math.max(0, viewportHeight - itemHeight)));
}
function createContextMenuItem(row, path) {
	return {
		kind: row.kind,
		name: getFileTreeRowAriaLabel(row),
		path
	};
}
function getFileTreeRootDomId(instanceId) {
	return instanceId == null ? void 0 : `${instanceId}__tree`;
}
function getFileTreeFocusedRowDomId(instanceId, path, parked) {
	if (instanceId == null) return;
	return `${instanceId}__focused-item-${encodeURIComponent(path)}${parked ? "__parked" : ""}`;
}
function isBuiltInDecorationIconName(name) {
	return name === "file-tree-icon-chevron" || name === "file-tree-icon-dot" || name === "file-tree-icon-file" || name === "file-tree-icon-lock";
}
function renderRowDecoration(decoration, resolveIcon) {
	if (decoration == null) return null;
	if ("text" in decoration) return /* @__PURE__ */ jsxs("span", {
		title: decoration.title,
		children: decoration.text.split(" ").map((token, index) => /* @__PURE__ */ jsx("span", {
			"data-loc": token.startsWith("+") ? "add" : token.startsWith("−") || token.startsWith("-") ? "del" : undefined,
			children: token
		}, index))
	});
	const icon = typeof decoration.icon === "string" ? isBuiltInDecorationIconName(decoration.icon) ? resolveIcon(decoration.icon) : { name: decoration.icon } : isBuiltInDecorationIconName(decoration.icon.name) ? (() => {
		const resolvedIcon = resolveIcon(decoration.icon.name);
		const { name: _ignoredName,...iconOverrides } = decoration.icon;
		return {
			...resolvedIcon,
			...iconOverrides
		};
	})() : decoration.icon;
	return /* @__PURE__ */ jsx("span", {
		title: decoration.title,
		children: /* @__PURE__ */ jsx(Icon, { ...icon })
	});
}
function focusFirstMenuElement(menuElement) {
	if (menuElement == null) return;
	focusElement(menuElement.querySelector([
		"button:not([disabled])",
		"[href]",
		"input:not([disabled])",
		"select:not([disabled])",
		"textarea:not([disabled])",
		"[tabindex]:not([tabindex=\"-1\"])"
	].join(", ")) ?? menuElement);
}
function renderFileTreeRowContent(row, resolveIcon, { actionLaneEnabled = false, customDecoration = null, decorationLaneEnabled = false, dragTargetFlattenedSegmentPath = null, gitDecoration = null, gitLaneActive = false, renameInput = null, showDecorativeActionAffordance = false } = {}) {
	const targetPath = getFileTreeRowPath(row);
	return /* @__PURE__ */ jsxs(Fragment, { children: [
		row.depth > 0 ? /* @__PURE__ */ jsx("div", {
			"data-item-section": "spacing",
			children: Array.from({ length: row.depth }).map((_, index) => /* @__PURE__ */ jsx("div", {
				"data-item-section": "spacing-item",
				"data-ancestor-path": row.ancestorPaths[index]
			}, index))
		}) : null,
		/* @__PURE__ */ jsx("div", {
			"data-item-section": "icon",
			children: row.kind === "directory" ? /* @__PURE__ */ jsx(Icon, { ...resolveIcon("file-tree-icon-chevron") }) : /* @__PURE__ */ jsx(Icon, { ...resolveIcon("file-tree-icon-file", targetPath) })
		}),
		/* @__PURE__ */ jsx("div", {
			"data-item-section": "content",
			children: row.isFlattened ? formatFlattenedSegments(row, renameInput, dragTargetFlattenedSegmentPath) : renameInput ?? /* @__PURE__ */ jsx(MiddleTruncate, {
				minimumLength: 5,
				split: "extension",
				children: row.name
			})
		}),
		decorationLaneEnabled ? /* @__PURE__ */ jsx("div", {
			"data-item-section": "decoration",
			children: customDecoration != null ? renderRowDecoration(customDecoration, resolveIcon) : null
		}) : null,
		gitLaneActive ? /* @__PURE__ */ jsx("div", {
			"data-item-section": "git",
			children: renderRowDecoration(gitDecoration, resolveIcon)
		}) : null,
		actionLaneEnabled ? /* @__PURE__ */ jsx("div", {
			"data-item-section": "action",
			children: showDecorativeActionAffordance ? /* @__PURE__ */ jsx("span", {
				"aria-hidden": "true",
				"data-item-action-affordance": "decorative",
				children: /* @__PURE__ */ jsx(Icon, { ...resolveIcon("file-tree-icon-ellipsis") })
			}) : null
		}) : null
	] });
}
function renderStyledRow(frame, row, key, options = {}) {
	const { controller, renameView, visualFocusPath, contextHoverPath, draggedPathSet, dragTarget, dragAndDropEnabled, shouldSuppressContextMenu, handleRowDragStart, handleRowDragEnd, handleRowTouchStart, instanceId, itemHeight, gitStatusByPath, ignoredGitDirectories, ignoredInheritanceCache, directoriesWithGitChanges, gitLaneActive, contextMenuEnabled, contextMenuTriggerMode, contextMenuButtonTriggerEnabled, contextMenuButtonVisibility, contextMenuRightClickEnabled, registerRenameInput, registerButton, resolveIcon, renderDecorationForRow, openContextMenuForRow, onRowClick, onKeyDown } = frame;
	const targetPath = getFileTreeRowPath(row);
	const { isParked = false, mode = "flow", style } = options;
	const isSticky = mode === "sticky";
	const effectiveGitStatus = gitStatusByPath?.get(targetPath) ?? null ?? getInheritedIgnoredGitStatus(row.ancestorPaths, ignoredGitDirectories, ignoredInheritanceCache);
	const containsGitChange = row.kind === "directory" && (directoriesWithGitChanges?.has(targetPath) ?? false);
	const customDecoration = renderDecorationForRow(row, targetPath);
	const gitDecoration = getBuiltInGitStatusDecoration(effectiveGitStatus, containsGitChange);
	const actionLaneEnabled = contextMenuEnabled && contextMenuButtonTriggerEnabled;
	const decorationLaneEnabled = customDecoration != null || gitLaneActive || actionLaneEnabled;
	const showDecorativeActionAffordance = actionLaneEnabled && contextMenuButtonVisibility === "always";
	const isRenamingRow = renameView.getPath() === targetPath;
	const renamingValue = isRenamingRow ? renameView.getValue() : "";
	const renameInput = isSticky || !isRenamingRow ? null : /* @__PURE__ */ jsx(RenameInput, {
		ref: registerRenameInput,
		ariaLabel: `Rename ${getFileTreeRowAriaLabel(row)}`,
		isFlattened: row.isFlattened,
		value: renamingValue,
		onBlur: () => {
			renameView.commit();
		},
		onInput: (event) => {
			renameView.setValue(event.currentTarget.value);
		}
	});
	const rowContent = renderFileTreeRowContent(row, resolveIcon, {
		actionLaneEnabled,
		customDecoration,
		decorationLaneEnabled,
		dragTargetFlattenedSegmentPath: dragTarget?.flattenedSegmentPath ?? null,
		gitDecoration,
		gitLaneActive,
		renameInput,
		showDecorativeActionAffordance
	});
	const commonProps = {
		...computeFileTreeRowElementAttributes({
			ariaLabel: getFileTreeRowAriaLabel(row),
			domId: row.isFocused ? getFileTreeFocusedRowDomId(instanceId, targetPath, isParked) : void 0,
			extraStyle: style,
			features: {
				actionLaneEnabled,
				contextMenuButtonVisibility: actionLaneEnabled ? contextMenuButtonVisibility : null,
				contextMenuEnabled,
				contextMenuTriggerMode: contextMenuEnabled ? contextMenuTriggerMode : null,
				gitLaneActive
			},
			isParked,
			itemHeight,
			mode,
			row,
			state: {
				containsGitChange,
				effectiveGitStatus,
				isContextHovered: contextHoverPath === targetPath,
				isDragTarget: dragTarget?.kind === "directory" && dragTarget.directoryPath === targetPath,
				isDragging: draggedPathSet?.has(targetPath) === true,
				isFocusRinged: row.isFocused && visualFocusPath === targetPath
			},
			targetPath
		}),
		key,
		onContextMenu: contextMenuEnabled || dragAndDropEnabled ? (event) => {
			if (shouldSuppressContextMenu()) {
				event.preventDefault();
				return;
			}
			if (!contextMenuEnabled) return;
			event.preventDefault();
			if (!contextMenuRightClickEnabled) return;
			controller.focusMountedPathFromInput(targetPath);
			openContextMenuForRow(row, targetPath, {
				anchorRect: createAnchorRectFromPoint(event.clientX, event.clientY),
				source: "right-click"
			});
		} : void 0,
		onFocus: !isSticky ? () => {
			controller.focusMountedPathFromInput(targetPath);
		} : void 0,
		onKeyDown: !isSticky ? onKeyDown : void 0,
		ref: (element) => {
			registerButton(targetPath, element);
		}
	};
	if (!isSticky && isRenamingRow) return /* @__PURE__ */ jsx("div", {
		...commonProps,
		children: rowContent
	});
	return /* @__PURE__ */ jsx("button", {
		...commonProps,
		type: "button",
		draggable: dragAndDropEnabled && !isParked,
		onDragEnd: dragAndDropEnabled && !isParked ? handleRowDragEnd : void 0,
		onDragStart: dragAndDropEnabled && !isParked ? (event) => {
			handleRowDragStart(event, row, targetPath);
		} : void 0,
		onMouseDown: (event) => {
			if (isSticky) {
				event.preventDefault();
				return;
			}
			if (controller.isSearchOpen()) event.preventDefault();
		},
		onTouchStart: dragAndDropEnabled && !isParked ? (event) => {
			handleRowTouchStart(event, row, targetPath);
		} : void 0,
		onClick: (event) => {
			onRowClick(event, row, targetPath, mode);
		},
		children: rowContent
	});
}
function renderRangeChildren(frame, range, hiddenRowPaths) {
	if (range.end < range.start) return [];
	return frame.controller.getVisibleRows(range.start, range.end).filter((row) => !hiddenRowPaths.has(getFileTreeRowPath(row))).map((row, slotIndex) => renderStyledRow(frame, row, range.start + slotIndex));
}
function FileTreeView({ composition, controller, gitStatusByPath, ignoredGitDirectories, directoriesWithGitChanges, icons, instanceId, itemHeight = FILE_TREE_DEFAULT_ITEM_HEIGHT, overscan = FILE_TREE_DEFAULT_OVERSCAN, renamingEnabled = false, renderRowDecoration: renderRowDecoration$1, searchBlurBehavior = "close", searchEnabled = false, searchFakeFocus = false, slotHost, stickyFolders = false, initialViewportHeight = FILE_TREE_DEFAULT_VIEWPORT_HEIGHT }) {
	"use no memo";
	const contextMenuAnchorRef = useRef(null);
	const contextMenuTriggerRef = useRef(null);
	const isScrollingRef = useRef(false);
	const listRef = useRef(null);
	const renameInputRef = useRef(null);
	const rootRef = useRef(null);
	const scrollRef = useRef(null);
	const searchInputRef = useRef(null);
	const rowButtonRefs = useRef(/* @__PURE__ */ new Map());
	const stickyRowButtonRefs = useRef(/* @__PURE__ */ new Map());
	const updateViewportRef = useRef(() => {});
	const measuredViewportHeightRef = useRef(null);
	const processedScrollRequestIdRef = useRef(0);
	const initialFocusedScrollAppliedRef = useRef(false);
	const initialFocusedScrollControllerRef = useRef(null);
	if (initialFocusedScrollControllerRef.current !== controller) {
		initialFocusedScrollAppliedRef.current = false;
		initialFocusedScrollControllerRef.current = controller;
	}
	const domFocusOwnerRef = useRef(false);
	const previousFocusedPathRef = useRef(null);
	const previousRenamingPathRef = useRef(null);
	const restoreTreeFocusAfterSearchCloseRef = useRef(false);
	const restoreTreeFocusViewportOffsetRef = useRef(null);
	const dragAutoScrollFrameRef = useRef(null);
	const dragHoverOpenKeyRef = useRef(null);
	const dragHoverOpenTimerRef = useRef(null);
	const dragPointRef = useRef(null);
	const dragPreviewRef = useRef(null);
	const dragRowSnapshotRef = useRef(null);
	const touchCleanupRef = useRef(null);
	const touchDragActiveRef = useRef(false);
	const touchPreviewOffsetRef = useRef(null);
	const touchSourceElementRef = useRef(null);
	const touchStartPointRef = useRef(null);
	const touchLongPressTimerRef = useRef(null);
	const ignoredInheritanceCache = useMemo(() => /* @__PURE__ */ new Map(), []);
	const [, setControllerRevision] = useState(0);
	const [activeItemPath, setActiveItemPath] = useState(null);
	const [contextHoverPath, setContextHoverPath] = useState(null);
	const [contextMenuAnchorTop, setContextMenuAnchorTop] = useState(null);
	const [lastContextMenuInteraction, setLastContextMenuInteraction] = useState(null);
	const [scrollSettledRevision, setScrollSettledRevision] = useState(0);
	const [contextMenuState, setContextMenuState] = useState(null);
	const contextMenuStateRef = useRef(contextMenuState);
	contextMenuStateRef.current = contextMenuState;
	const pendingStickyFocusPathRef = useRef(null);
	const pendingStickyKeyboardFocusPathRef = useRef(null);
	const pendingStickyKeyboardViewportOffsetRef = useRef(null);
	const pendingStickyKeyboardScrollTopRef = useRef(null);
	const debugContextMenuTriggerPathRef = useRef(null);
	const debugDisableScrollSuppressionRef = useRef(false);
	const clearPendingStickyKeyboardState = () => {
		pendingStickyKeyboardFocusPathRef.current = null;
		pendingStickyKeyboardViewportOffsetRef.current = null;
		pendingStickyKeyboardScrollTopRef.current = null;
	};
	const preserveStickyKeyboardFocusAtScrollTop = (path, scrollTop) => {
		pendingStickyKeyboardFocusPathRef.current = path;
		pendingStickyKeyboardViewportOffsetRef.current = null;
		pendingStickyKeyboardScrollTopRef.current = scrollTop == null ? null : {
			path,
			scrollTop
		};
	};
	const restoreStickyKeyboardViewportOffset = (path, viewportOffset) => {
		pendingStickyKeyboardFocusPathRef.current = null;
		pendingStickyKeyboardViewportOffsetRef.current = {
			path,
			viewportOffset
		};
		pendingStickyKeyboardScrollTopRef.current = null;
	};
	const skipInitialSearchAutoFocusRef = useRef(searchBlurBehavior === "retain" && controller.isSearchOpen());
	const [fakeSearchFocusActive, setFakeSearchFocusActive] = useState(searchFakeFocus);
	useEffect(() => {
		if (!searchFakeFocus) setFakeSearchFocusActive(false);
	}, [searchFakeFocus]);
	const searchInputUserInteractedRef = useRef(false);
	const markSearchInputInteracted = useCallback(() => {
		searchInputUserInteractedRef.current = true;
		setFakeSearchFocusActive((previous) => previous ? false : previous);
	}, []);
	const [layoutState, setLayoutState] = useState(() => computeFileTreeViewLayoutState({
		controller,
		itemHeight,
		overscan,
		scrollTop: 0,
		stickyFolders,
		viewportHeight: initialViewportHeight
	}));
	const [hasStickyUiMount, setHasStickyUiMount] = useState(false);
	useEffect(() => {
		setHasStickyUiMount(true);
	}, []);
	const contextMenuEnabled = composition?.contextMenu?.enabled === true || composition?.contextMenu?.render != null || composition?.contextMenu?.onOpen != null || composition?.contextMenu?.onClose != null;
	const contextMenuTriggerMode = composition?.contextMenu?.triggerMode ?? (contextMenuEnabled ? "right-click" : "both");
	const contextMenuButtonTriggerEnabled = contextMenuTriggerMode === "both" || contextMenuTriggerMode === "button";
	const contextMenuButtonVisibility = composition?.contextMenu?.buttonVisibility ?? "when-needed";
	const contextMenuRightClickEnabled = contextMenuTriggerMode === "both" || contextMenuTriggerMode === "right-click";
	useLayoutEffect(() => {
		const rootElement = rootRef.current;
		if (rootElement == null) return;
		const handleDebugSetContextMenuTrigger = (event) => {
			if (!(event instanceof CustomEvent)) return;
			const nextPath = event.detail?.path ?? null;
			debugContextMenuTriggerPathRef.current = nextPath;
			setContextHoverPath(nextPath);
			setLastContextMenuInteraction(nextPath == null ? null : "pointer");
		};
		const handleDebugSetScrollSuppression = (event) => {
			if (!(event instanceof CustomEvent)) return;
			debugDisableScrollSuppressionRef.current = event.detail?.disabled === true;
		};
		rootElement.addEventListener("file-tree-debug-set-context-menu-trigger", handleDebugSetContextMenuTrigger);
		rootElement.addEventListener("file-tree-debug-set-scroll-suppression", handleDebugSetScrollSuppression);
		return () => {
			rootElement.removeEventListener("file-tree-debug-set-context-menu-trigger", handleDebugSetContextMenuTrigger);
			rootElement.removeEventListener("file-tree-debug-set-scroll-suppression", handleDebugSetScrollSuppression);
		};
	}, []);
	const registerRowButton = useCallback((path, element) => {
		setButtonRef(rowButtonRefs.current, path, element);
	}, []);
	const registerStickyRowButton = useCallback((path, element) => {
		setButtonRef(stickyRowButtonRefs.current, path, element);
	}, []);
	const registerRenameInput = useCallback((element) => {
		renameInputRef.current = element;
	}, []);
	const getTriggerAnchorButton = useCallback((path) => {
		return getContextMenuAnchorButton(path, stickyRowButtonRefs.current, rowButtonRefs.current);
	}, []);
	const gitLaneActive = gitStatusByPath != null || ignoredGitDirectories != null || directoriesWithGitChanges != null;
	const { resolveIcon } = useMemo(() => createFileTreeIconResolver(icons), [icons]);
	const renameView = controller[FILE_TREE_RENAME_VIEW]();
	const renamingPath = renameView.getPath();
	const isRenaming = renamingPath != null;
	const isSearchOpen = controller.isSearchOpen();
	const searchValue = controller.getSearchValue();
	const focusedPath = controller.getFocusedPath();
	const focusedIndex = controller.getFocusedIndex();
	const scrollRequest = controller.getScrollRequest();
	const dragAndDropEnabled = controller.isDragAndDropEnabled();
	const dragSession = controller.getDragSession();
	const draggedPathSet = useMemo(() => dragSession == null ? null : new Set(dragSession.draggedPaths), [dragSession]);
	const dragTarget = dragSession?.target ?? null;
	const draggedPrimaryPath = dragSession?.primaryPath ?? null;
	const treeDomId = getFileTreeRootDomId(instanceId);
	const { overlayHeight: overlayRowsHeight, overlayRows, snapshot: layoutSnapshot, visibleRows } = layoutState;
	const resolvedViewportHeight = layoutSnapshot.physical.viewportHeight;
	const range = useMemo(() => ({
		end: layoutSnapshot.window.endIndex,
		start: layoutSnapshot.window.startIndex
	}), [layoutSnapshot.window.endIndex, layoutSnapshot.window.startIndex]);
	const stickyRows = overlayRows;
	const occludedStickyRows = layoutSnapshot.sticky.rows;
	const totalScrollableHeight = layoutSnapshot.physical.totalHeight;
	const stickyOverlayHeight = layoutSnapshot.sticky.height;
	const stickyRowPathSet = useMemo(() => new Set(occludedStickyRows.map((entry) => getFileTreeRowPath(entry.row))), [occludedStickyRows]);
	const focusedRowIsMounted = focusedIndex >= 0 && focusedIndex >= range.start && focusedIndex <= range.end;
	const renderDecorationForRow = useCallback((row, targetPath) => renderRowDecoration$1?.({
		item: createContextMenuItem(row, targetPath),
		row
	}) ?? null, [renderRowDecoration$1]);
	const restoreContextMenuFocus = useCallback((restorePath) => {
		if (focusElement(restorePath == null ? null : rowButtonRefs.current.get(restorePath) ?? null)) return true;
		return focusElement(rootRef.current);
	}, []);
	const restoreFocusToTree = useCallback((path) => {
		restoreContextMenuFocus(controller.focusNearestPath(path));
	}, [controller, restoreContextMenuFocus]);
	const restoreFocusToTreeRef = useRef(restoreFocusToTree);
	restoreFocusToTreeRef.current = restoreFocusToTree;
	const shouldRestoreContextMenuFocusRef = useRef(true);
	const closeContextMenuRef = useRef(() => {});
	const closeContextMenu = useCallback((restoreFocus = true) => {
		const currentContextMenuState = contextMenuStateRef.current;
		if (currentContextMenuState == null) return;
		shouldRestoreContextMenuFocusRef.current = shouldRestoreContextMenuFocusRef.current && restoreFocus;
		setContextMenuState(null);
		composition?.contextMenu?.onClose?.();
		if (shouldRestoreContextMenuFocusRef.current) restoreFocusToTree(currentContextMenuState.path);
	}, [composition?.contextMenu, restoreFocusToTree]);
	closeContextMenuRef.current = closeContextMenu;
	const updateTriggerPosition = useCallback((itemButton) => {
		const nextTop = itemButton == null ? null : getContextMenuAnchorTop(rootRef.current, itemButton);
		setContextMenuAnchorTop((previousTop) => previousTop === nextTop ? previousTop : nextTop);
	}, []);
	const openContextMenuForRow = useCallback((row, targetPath, options) => {
		const item = controller.getItem(targetPath);
		if (item == null) return;
		const anchorButton = getTriggerAnchorButton(targetPath);
		if (anchorButton?.dataset.fileTreeStickyRow === "true") {
			const scrollElement = scrollRef.current;
			preserveStickyKeyboardFocusAtScrollTop(targetPath, scrollElement?.scrollTop ?? null);
			domFocusOwnerRef.current = true;
			setActiveItemPath((previousPath) => previousPath === targetPath ? previousPath : targetPath);
		}
		item.focus();
		updateTriggerPosition(anchorButton);
		shouldRestoreContextMenuFocusRef.current = true;
		setContextMenuState({
			anchorRect: options?.anchorRect ?? null,
			item: createContextMenuItem(row, targetPath),
			path: targetPath,
			source: options?.source ?? "keyboard"
		});
	}, [
		controller,
		getTriggerAnchorButton,
		updateTriggerPosition
	]);
	const startRenameFromPath = useCallback((path) => {
		if (!renamingEnabled) return;
		if (controller.isSearchOpen()) {
			const scrollElement = scrollRef.current;
			const viewportHeight = readMeasuredViewportHeight(scrollElement, resolvedViewportHeight);
			restoreTreeFocusViewportOffsetRef.current = focusedIndex < 0 || scrollElement == null ? null : Math.max(0, Math.min(focusedIndex * itemHeight - scrollElement.scrollTop, Math.max(0, viewportHeight - itemHeight)));
			restoreTreeFocusAfterSearchCloseRef.current = true;
		}
		if (controller.startRenaming(path) === false) return;
		setLastContextMenuInteraction("focus");
		setControllerRevision((revision) => revision + 1);
	}, [
		controller,
		focusedIndex,
		itemHeight,
		renamingEnabled,
		resolvedViewportHeight
	]);
	const revealCanonicalRowAtStickyOffset = useCallback((path, { restoreTreeFocus = true, targetOffset = "live-overlay" } = {}) => {
		const scrollElement = scrollRef.current;
		if (scrollElement == null) return false;
		controller.focusPath(path);
		const visibleIndex = controller.getFocusedIndex();
		if (visibleIndex < 0) return false;
		const focusedRow = controller.getVisibleRows(visibleIndex, visibleIndex)[0] ?? null;
		if (focusedRow == null) return false;
		const liveViewportHeight = readMeasuredViewportHeight(scrollElement, resolvedViewportHeight);
		const liveTotalHeight = controller.getVisibleCount() * itemHeight;
		const targetViewportOffset = targetOffset === "sticky-parents" ? focusedRow.ancestorPaths.length * itemHeight : computeFileTreeViewLayoutState({
			controller,
			itemHeight,
			overscan,
			scrollTop: scrollElement.scrollTop,
			stickyFolders,
			viewportHeight: liveViewportHeight
		}).snapshot.sticky.height;
		domFocusOwnerRef.current = true;
		scrollFocusedRowToViewportOffset(scrollElement, visibleIndex, itemHeight, liveViewportHeight, liveTotalHeight, targetViewportOffset);
		updateViewportRef.current();
		pendingStickyFocusPathRef.current = restoreTreeFocus ? path : null;
		return true;
	}, [
		controller,
		itemHeight,
		overscan,
		resolvedViewportHeight,
		stickyFolders
	]);
	const shouldSuppressContextMenu = () => {
		return isScrollingRef.current === true || touchLongPressTimerRef.current != null || touchDragActiveRef.current === true;
	};
	const requestDragAnimationFrame = (callback) => {
		return typeof window.requestAnimationFrame === "function" ? window.requestAnimationFrame(() => {
			callback();
		}) : window.setTimeout(callback, 16);
	};
	const cancelDragAnimationFrame = (handle) => {
		if (handle == null) return;
		if (typeof window.cancelAnimationFrame === "function") {
			window.cancelAnimationFrame(handle);
			return;
		}
		window.clearTimeout(handle);
	};
	const clearDragHoverOpen = () => {
		if (dragHoverOpenTimerRef.current != null) {
			clearTimeout(dragHoverOpenTimerRef.current);
			dragHoverOpenTimerRef.current = null;
		}
		dragHoverOpenKeyRef.current = null;
	};
	const clearDragPreview = () => {
		dragPreviewRef.current?.remove();
		dragPreviewRef.current = null;
	};
	const stopDragAutoScroll = () => {
		cancelDragAnimationFrame(dragAutoScrollFrameRef.current);
		dragAutoScrollFrameRef.current = null;
		dragPointRef.current = null;
	};
	const mountDragPreview = (preview) => {
		const rootNode = rootRef.current?.getRootNode();
		if (rootNode instanceof ShadowRoot) {
			rootNode.append(preview);
			return;
		}
		document.body.append(preview);
	};
	const clearTouchDragResources = () => {
		touchCleanupRef.current?.();
		touchCleanupRef.current = null;
		if (touchLongPressTimerRef.current != null) {
			clearTimeout(touchLongPressTimerRef.current);
			touchLongPressTimerRef.current = null;
		}
		touchDragActiveRef.current = false;
		touchPreviewOffsetRef.current = null;
		touchStartPointRef.current = null;
		if (touchSourceElementRef.current != null) {
			touchSourceElementRef.current.setAttribute("draggable", "true");
			touchSourceElementRef.current.style.removeProperty("touch-action");
			touchSourceElementRef.current = null;
		}
		clearDragPreview();
		clearDragHoverOpen();
		stopDragAutoScroll();
		dragRowSnapshotRef.current = null;
	};
	const syncDropTargetFromPoint = (clientX, clientY) => {
		const rootNode = rootRef.current?.getRootNode();
		const nextTarget = resolveDropTargetFromElement(getPointElement(rootNode instanceof ShadowRoot ? rootNode : document, clientX, clientY));
		controller.setDragTarget(nextTarget);
		return controller.getDragSession()?.target ?? null;
	};
	const scheduleDragHoverOpen = (nextTarget) => {
		const openDelay = controller.getDragAndDropConfig()?.openOnDropDelay ?? 800;
		if (nextTarget == null || nextTarget.kind !== "directory" || nextTarget.directoryPath == null || openDelay <= 0) {
			clearDragHoverOpen();
			return;
		}
		const targetItem = controller.getItem(nextTarget.directoryPath);
		const directoryItem = isFileTreeDirectoryHandle(targetItem) ? targetItem : null;
		if (directoryItem == null || directoryItem.isExpanded()) {
			clearDragHoverOpen();
			return;
		}
		const nextKey = `${nextTarget.directoryPath}::${nextTarget.flattenedSegmentPath ?? ""}`;
		if (dragHoverOpenKeyRef.current === nextKey) return;
		clearDragHoverOpen();
		dragHoverOpenKeyRef.current = nextKey;
		dragHoverOpenTimerRef.current = setTimeout(() => {
			const currentTarget = controller.getDragSession()?.target;
			if (currentTarget?.kind !== "directory" || currentTarget.directoryPath !== nextTarget.directoryPath || currentTarget.flattenedSegmentPath !== nextTarget.flattenedSegmentPath) return;
			directoryItem.expand();
		}, openDelay);
	};
	const runDragAutoScroll = () => {
		dragAutoScrollFrameRef.current = null;
		const dragPoint = dragPointRef.current;
		const scrollElement = scrollRef.current;
		if (dragPoint == null || scrollElement == null || controller.getDragSession() == null) return;
		const scrollRect = scrollElement.getBoundingClientRect();
		const scrollDelta = getDragEdgeScrollDelta(dragPoint.clientY, scrollRect);
		if (scrollDelta === 0) return;
		const maxScrollTop = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
		const boundedScrollTop = Math.max(0, Math.min(maxScrollTop, scrollElement.scrollTop + scrollDelta));
		if (boundedScrollTop !== scrollElement.scrollTop) {
			scrollElement.scrollTop = boundedScrollTop;
			updateViewportRef.current();
		}
		scheduleDragHoverOpen(syncDropTargetFromPoint(dragPoint.clientX, dragPoint.clientY));
		dragAutoScrollFrameRef.current = requestDragAnimationFrame(runDragAutoScroll);
	};
	const updateDragPoint = (clientX, clientY) => {
		dragPointRef.current = {
			clientX,
			clientY
		};
		dragAutoScrollFrameRef.current ??= requestDragAnimationFrame(runDragAutoScroll);
	};
	const handleRowDragStart = (event, row, targetPath) => {
		const dragSource = event.currentTarget;
		if (dragSource == null) return;
		clearTouchDragResources();
		clearDragPreview();
		clearDragHoverOpen();
		stopDragAutoScroll();
		if (controller.startDrag(targetPath) === false) {
			event.preventDefault();
			return;
		}
		dragRowSnapshotRef.current = row;
		if (event.dataTransfer != null) {
			event.dataTransfer.effectAllowed = "move";
			event.dataTransfer.dropEffect = "move";
			event.dataTransfer.setData("text/plain", targetPath);
			if (shouldUseCustomPointerDragImage()) {
				const preview = createDragPreviewElement(dragSource);
				const rect = dragSource.getBoundingClientRect();
				Object.assign(preview.style, {
					height: `${rect.height}px`,
					opacity: "0.85",
					transform: "translate3d(-9999px, 0px, 0)",
					width: `${rect.width}px`
				});
				mountDragPreview(preview);
				dragPreviewRef.current = preview;
				event.dataTransfer.setDragImage(preview, Math.max(0, event.clientX - rect.left), Math.max(0, event.clientY - rect.top));
			}
		}
	};
	const handleRowDragEnd = () => {
		clearDragPreview();
		clearDragHoverOpen();
		stopDragAutoScroll();
		dragRowSnapshotRef.current = null;
		controller.cancelDrag();
	};
	const handleRowTouchStart = (event, row, targetPath) => {
		if (touchLongPressTimerRef.current != null || touchDragActiveRef.current) return;
		const touch = event.touches[0];
		const dragSource = event.currentTarget;
		if (touch == null || dragSource == null) return;
		touchStartPointRef.current = {
			clientX: touch.clientX,
			clientY: touch.clientY
		};
		touchSourceElementRef.current = dragSource;
		dragSource.setAttribute("draggable", "false");
		const clearPendingTouchStart = (options = {}) => {
			const restoreNativeDraggable = options.restoreNativeDraggable ?? !touchDragActiveRef.current;
			if (touchLongPressTimerRef.current != null) {
				clearTimeout(touchLongPressTimerRef.current);
				touchLongPressTimerRef.current = null;
			}
			document.removeEventListener("touchmove", handlePendingTouchMove);
			document.removeEventListener("touchend", handlePendingTouchEnd);
			document.removeEventListener("touchcancel", handlePendingTouchEnd);
			if (touchCleanupRef.current === clearPendingTouchStart) touchCleanupRef.current = null;
			if (restoreNativeDraggable) {
				dragSource.setAttribute("draggable", "true");
				if (touchSourceElementRef.current === dragSource) touchSourceElementRef.current = null;
				touchStartPointRef.current = null;
			}
		};
		const handlePendingTouchMove = (moveEvent) => {
			const moveTouch = moveEvent.touches[0];
			const startPoint = touchStartPointRef.current;
			if (moveTouch == null || startPoint == null) return;
			const deltaX = moveTouch.clientX - startPoint.clientX;
			const deltaY = moveTouch.clientY - startPoint.clientY;
			if (deltaX * deltaX + deltaY * deltaY <= TOUCH_LONG_PRESS_MOVE_THRESHOLD * TOUCH_LONG_PRESS_MOVE_THRESHOLD) return;
			clearPendingTouchStart();
		};
		const handlePendingTouchEnd = () => {
			clearPendingTouchStart();
		};
		document.addEventListener("touchmove", handlePendingTouchMove, { passive: true });
		document.addEventListener("touchend", handlePendingTouchEnd);
		document.addEventListener("touchcancel", handlePendingTouchEnd);
		touchCleanupRef.current = clearPendingTouchStart;
		touchLongPressTimerRef.current = setTimeout(() => {
			clearPendingTouchStart({ restoreNativeDraggable: false });
			if (controller.startDrag(targetPath) === false) {
				dragSource.setAttribute("draggable", "true");
				if (touchSourceElementRef.current === dragSource) touchSourceElementRef.current = null;
				touchStartPointRef.current = null;
				return;
			}
			touchDragActiveRef.current = true;
			touchSourceElementRef.current = dragSource;
			dragSource.setAttribute("draggable", "false");
			dragSource.style.setProperty("touch-action", "none");
			dragRowSnapshotRef.current = row;
			const rect = dragSource.getBoundingClientRect();
			const preview = createDragPreviewElement(dragSource);
			Object.assign(preview.style, {
				height: `${rect.height}px`,
				opacity: "0.85",
				transform: `translate3d(${rect.left}px, ${rect.top}px, 0)`,
				width: `${rect.width}px`
			});
			mountDragPreview(preview);
			dragPreviewRef.current = preview;
			touchPreviewOffsetRef.current = {
				x: touch.clientX - rect.left,
				y: touch.clientY - rect.top
			};
			const handleActiveTouchMove = (moveEvent) => {
				const moveTouch = moveEvent.touches[0];
				if (moveTouch == null) return;
				moveEvent.preventDefault();
				const previewOffset = touchPreviewOffsetRef.current;
				if (previewOffset != null && dragPreviewRef.current != null) dragPreviewRef.current.style.transform = `translate3d(${moveTouch.clientX - previewOffset.x}px, ${moveTouch.clientY - previewOffset.y}px, 0)`;
				scheduleDragHoverOpen(syncDropTargetFromPoint(moveTouch.clientX, moveTouch.clientY));
				updateDragPoint(moveTouch.clientX, moveTouch.clientY);
			};
			const handleActiveTouchEnd = (endEvent) => {
				const endTouch = endEvent.changedTouches[0];
				if (endTouch != null) syncDropTargetFromPoint(endTouch.clientX, endTouch.clientY);
				controller.completeDrag();
				clearTouchDragResources();
			};
			const handleActiveTouchCancel = () => {
				controller.cancelDrag();
				clearTouchDragResources();
			};
			touchCleanupRef.current = () => {
				document.removeEventListener("touchmove", handleActiveTouchMove);
				document.removeEventListener("touchend", handleActiveTouchEnd);
				document.removeEventListener("touchcancel", handleActiveTouchCancel);
			};
			document.addEventListener("touchmove", handleActiveTouchMove, { passive: false });
			document.addEventListener("touchend", handleActiveTouchEnd);
			document.addEventListener("touchcancel", handleActiveTouchCancel);
		}, TOUCH_LONG_PRESS_DELAY);
	};
	const handleTreeKeyDown = (event) => {
		if (contextMenuState != null) {
			if (event.key === "Escape") {
				closeContextMenu();
				event.preventDefault();
				event.stopPropagation();
				return;
			}
			if (BLOCKED_CONTEXT_MENU_NAV_KEYS.has(event.key)) {
				event.preventDefault();
				event.stopPropagation();
			}
			return;
		}
		if (renameView.isActive()) {
			if (event.key === "Escape") renameView.cancel();
			else if (event.key === "Enter") renameView.commit();
			else return;
			setLastContextMenuInteraction("focus");
			setControllerRevision((revision) => revision + 1);
			event.preventDefault();
			event.stopPropagation();
			return;
		}
		if (renamingEnabled && event.key === "F2") {
			startRenameFromPath(focusedPath ?? void 0);
			event.preventDefault();
			event.stopPropagation();
			return;
		}
		if (isSearchOpen) {
			if (event.key === "Escape") {
				restoreTreeFocusAfterSearchCloseRef.current = false;
				restoreTreeFocusViewportOffsetRef.current = null;
				controller.closeSearch();
			} else if (event.key === "Enter") {
				const currentFocusedPath = controller.getFocusedPath();
				if (currentFocusedPath != null) controller.selectOnlyPath(currentFocusedPath);
				const scrollElement$1 = scrollRef.current;
				const viewportHeight = readMeasuredViewportHeight(scrollElement$1, resolvedViewportHeight);
				restoreTreeFocusViewportOffsetRef.current = focusedIndex < 0 || scrollElement$1 == null ? null : Math.max(0, Math.min(focusedIndex * itemHeight - scrollElement$1.scrollTop, Math.max(0, viewportHeight - itemHeight)));
				restoreTreeFocusAfterSearchCloseRef.current = true;
				controller.closeSearch();
			} else if (event.key === "ArrowDown") controller.focusNextSearchMatch();
			else if (event.key === "ArrowUp") controller.focusPreviousSearchMatch();
			else return;
			setLastContextMenuInteraction("focus");
			setControllerRevision((revision) => revision + 1);
			event.preventDefault();
			event.stopPropagation();
			return;
		}
		if (searchEnabled && isSearchOpenSeedKey(event)) {
			controller.openSearch(event.key);
			setControllerRevision((revision) => revision + 1);
			event.preventDefault();
			event.stopPropagation();
			return;
		}
		const isKeyboardContextMenuRequest = contextMenuEnabled && isContextMenuOpenKey(event);
		const shouldInspectStickyKeyboardState = canKeyUseStickyKeyboardState(event, contextMenuEnabled);
		const activeTreeElement = shouldInspectStickyKeyboardState && rootRef.current != null ? getActiveTreeElement(rootRef.current) : null;
		const mountedStickyRowPathSet = shouldInspectStickyKeyboardState ? new Set(getMountedStickyRowPaths(rootRef.current)) : /* @__PURE__ */ new Set();
		const activeStickyFocusPath = activeTreeElement?.dataset.fileTreeStickyPath ?? null;
		const activeStickyRowOwnsFocus = activeTreeElement?.dataset.fileTreeStickyRow === "true" && activeStickyFocusPath != null;
		if (activeStickyRowOwnsFocus && activeStickyFocusPath !== focusedPath && mountedStickyRowPathSet.has(activeStickyFocusPath)) {
			const scrollElement$1 = scrollRef.current;
			preserveStickyKeyboardFocusAtScrollTop(activeStickyFocusPath, scrollElement$1?.scrollTop ?? null);
			controller.focusPath(activeStickyFocusPath);
		}
		const effectiveFocusedPath = controller.getFocusedPath();
		const effectiveFocusedIndex = controller.getFocusedIndex();
		const focusedItem = controller.getFocusedItem();
		if (focusedItem == null) return;
		const focusedDirectoryItem = isFileTreeDirectoryHandle(focusedItem) ? focusedItem : null;
		const startedFromStickyRow = effectiveFocusedPath != null && (stickyRowPathSet.has(effectiveFocusedPath) || activeStickyRowOwnsFocus && activeStickyFocusPath === effectiveFocusedPath && mountedStickyRowPathSet.has(effectiveFocusedPath));
		const shouldPreserveLocalStickyFocusMove = event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "ArrowRight" && focusedDirectoryItem != null && focusedDirectoryItem.isExpanded();
		const shouldRestoreCollapsedStickyFocusViewport = event.key === "ArrowLeft" && startedFromStickyRow && focusedDirectoryItem != null && focusedDirectoryItem.isExpanded();
		const scrollElement = scrollRef.current;
		let handled = true;
		if (event.shiftKey && event.key === "ArrowDown") controller.extendSelectionFromFocused(1);
		else if (event.shiftKey && event.key === "ArrowUp") controller.extendSelectionFromFocused(-1);
		else if (isKeyboardContextMenuRequest && effectiveFocusedPath != null && effectiveFocusedIndex >= 0) {
			const focusedRow = controller.getVisibleRows(effectiveFocusedIndex, effectiveFocusedIndex)[0] ?? null;
			const focusedButton = getContextMenuAnchorButton(effectiveFocusedPath, stickyRowButtonRefs.current, rowButtonRefs.current);
			if (focusedRow == null || focusedButton == null) handled = false;
			else openContextMenuForRow(focusedRow, effectiveFocusedPath);
		} else if ((event.ctrlKey || event.metaKey) && isSpaceSelectionKey(event)) controller.toggleFocusedSelection();
		else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") controller.selectAllVisiblePaths();
		else switch (event.key) {
			case "ArrowDown":
				controller.focusNextItem();
				break;
			case "ArrowUp":
				controller.focusPreviousItem();
				break;
			case "ArrowRight":
				if (focusedDirectoryItem == null || focusedDirectoryItem.isExpanded()) controller.focusNextItem();
				else focusedDirectoryItem.expand();
				break;
			case "ArrowLeft":
				if (focusedDirectoryItem != null && focusedDirectoryItem.isExpanded()) focusedDirectoryItem.collapse();
				else controller.focusParentItem();
				break;
			case "Home":
				controller.focusFirstItem();
				break;
			case "End":
				controller.focusLastItem();
				break;
			default: handled = false;
		}
		if (!handled) return;
		setLastContextMenuInteraction("focus");
		const nextFocusedPath = controller.getFocusedPath();
		const nextFocusedPathIsMountedSticky = nextFocusedPath != null && (stickyRowPathSet.has(nextFocusedPath) || mountedStickyRowPathSet.has(nextFocusedPath));
		const stickyKeyboardMoveLandsOnDifferentStickyRow = shouldPreserveLocalStickyFocusMove && nextFocusedPath !== effectiveFocusedPath;
		const stickyKeyboardMenuStaysOnStickyRow = isKeyboardContextMenuRequest && activeStickyRowOwnsFocus && activeStickyFocusPath === effectiveFocusedPath && nextFocusedPath === effectiveFocusedPath;
		if ((startedFromStickyRow || stickyKeyboardMenuStaysOnStickyRow) && nextFocusedPath != null && (stickyKeyboardMoveLandsOnDifferentStickyRow && nextFocusedPathIsMountedSticky || stickyKeyboardMenuStaysOnStickyRow)) {
			preserveStickyKeyboardFocusAtScrollTop(nextFocusedPath, scrollElement?.scrollTop ?? null);
			domFocusOwnerRef.current = true;
			setActiveItemPath((previousPath) => previousPath === nextFocusedPath ? previousPath : nextFocusedPath);
		} else {
			const stickyArrowUpExitsStack = event.key === "ArrowUp" && startedFromStickyRow && nextFocusedPath !== effectiveFocusedPath;
			if (nextFocusedPath != null && (stickyArrowUpExitsStack || shouldRestoreCollapsedStickyFocusViewport && nextFocusedPath === effectiveFocusedPath)) {
				restoreStickyKeyboardViewportOffset(nextFocusedPath, getStickyKeyboardViewportOffset(rootRef.current, scrollElement, activeTreeElement, effectiveFocusedPath, itemHeight, stickyOverlayHeight, resolvedViewportHeight));
				domFocusOwnerRef.current = true;
				setActiveItemPath((previousPath) => previousPath === nextFocusedPath ? previousPath : nextFocusedPath);
			} else clearPendingStickyKeyboardState();
		}
		setControllerRevision((revision) => revision + 1);
		event.preventDefault();
		event.stopPropagation();
	};
	useLayoutEffect(() => {
		if (!searchEnabled || !isSearchOpen) return;
		if (skipInitialSearchAutoFocusRef.current) {
			skipInitialSearchAutoFocusRef.current = false;
			return;
		}
		focusElement(searchInputRef.current);
	}, [isSearchOpen, searchEnabled]);
	useLayoutEffect(() => {
		const input = renameInputRef.current;
		switch (classifyFileTreeRenameHandoff({
			hasRenderedInput: input != null,
			previousRenamingPath: previousRenamingPathRef.current,
			renamingPath
		})) {
			case "reset":
				previousRenamingPathRef.current = null;
				return;
			case "reveal-canonical":
				if (renamingPath != null) revealCanonicalRowAtStickyOffset(renamingPath, {
					restoreTreeFocus: false,
					targetOffset: "live-overlay"
				});
				return;
			case "ignore": return;
			case "focus-input":
				if (input != null) {
					pendingStickyFocusPathRef.current = null;
					previousRenamingPathRef.current = renamingPath;
					focusElement(input);
					input.select();
				}
				return;
		}
	}, [
		range.end,
		range.start,
		renamingPath,
		revealCanonicalRowAtStickyOffset,
		stickyRowPathSet
	]);
	useLayoutEffect(() => {
		const rootElement = rootRef.current;
		if (rootElement == null) return;
		let nullFocusOutTimer = null;
		const clearNullFocusOutTimer = () => {
			if (nullFocusOutTimer == null) return;
			clearTimeout(nullFocusOutTimer);
			nullFocusOutTimer = null;
		};
		const updateActiveItemPath = () => {
			const nextActiveItemPath = getActiveTreeElement(rootElement)?.dataset.itemPath ?? null;
			setActiveItemPath((previousPath) => previousPath === nextActiveItemPath ? previousPath : nextActiveItemPath);
		};
		const onFocusIn = () => {
			clearNullFocusOutTimer();
			domFocusOwnerRef.current = true;
			updateActiveItemPath();
		};
		const onFocusOut = (event) => {
			const nextTarget = event.relatedTarget;
			if (nextTarget == null) {
				clearNullFocusOutTimer();
				nullFocusOutTimer = setTimeout(() => {
					nullFocusOutTimer = null;
					if (getActiveTreeElement(rootElement) != null) {
						updateActiveItemPath();
						return;
					}
					domFocusOwnerRef.current = false;
					setActiveItemPath(null);
				}, 0);
				return;
			}
			if (!(nextTarget instanceof Node) || !rootElement.contains(nextTarget)) {
				clearNullFocusOutTimer();
				domFocusOwnerRef.current = false;
				setActiveItemPath(null);
				return;
			}
			const nextActiveItemPath = nextTarget instanceof HTMLElement ? nextTarget.dataset.itemPath ?? null : null;
			setActiveItemPath((previousPath) => previousPath === nextActiveItemPath ? previousPath : nextActiveItemPath);
		};
		rootElement.addEventListener("focusin", onFocusIn);
		rootElement.addEventListener("focusout", onFocusOut);
		return () => {
			clearNullFocusOutTimer();
			rootElement.removeEventListener("focusin", onFocusIn);
			rootElement.removeEventListener("focusout", onFocusOut);
		};
	}, []);
	useLayoutEffect(() => {
		const rootElement = rootRef.current;
		if (rootElement == null) return;
		if (layoutSnapshot.physical.scrollTop <= 0) rootElement.dataset.scrollAtTop = "true";
		else delete rootElement.dataset.scrollAtTop;
	}, [layoutSnapshot.physical.scrollTop]);
	useLayoutEffect(() => {
		let scrollTimer = null;
		const scrollElement = scrollRef.current;
		const listElement = listRef.current;
		const rootElement = rootRef.current;
		if (scrollElement == null) return;
		measuredViewportHeightRef.current = readMeasuredViewportHeight(scrollElement, initialViewportHeight);
		const update = () => {
			const nextItemCount = controller.getVisibleCount();
			const nextViewportHeight = getCachedViewportHeight(measuredViewportHeightRef.current, initialViewportHeight);
			const maxScrollTop = Math.max(0, nextItemCount * itemHeight - nextViewportHeight);
			if (scrollElement.scrollTop > maxScrollTop) scrollElement.scrollTop = maxScrollTop;
			setLayoutState(computeFileTreeViewLayoutState({
				controller,
				itemHeight,
				overscan,
				scrollTop: Math.min(scrollElement.scrollTop, maxScrollTop),
				stickyFolders,
				viewportHeight: nextViewportHeight
			}));
		};
		if (!initialFocusedScrollAppliedRef.current) {
			initialFocusedScrollAppliedRef.current = true;
			const initialFocusedIndex = controller.getFocusedIndex();
			if (initialFocusedIndex >= 0) {
				const initialViewportHeightPx = getCachedViewportHeight(measuredViewportHeightRef.current, initialViewportHeight);
				const initialFocusedRow = controller.getVisibleRows(initialFocusedIndex, initialFocusedIndex)[0] ?? null;
				scrollFocusedRowIntoView(scrollElement, initialFocusedIndex, itemHeight, initialViewportHeightPx, stickyFolders && initialFocusedRow != null ? Math.max(0, Math.min(initialFocusedRow.ancestorPaths.length * itemHeight, Math.max(0, initialViewportHeightPx - itemHeight))) : 0);
			}
		}
		updateViewportRef.current = update;
		let hasSeenInitialControllerSnapshot = false;
		const unsubscribe = controller.subscribe(() => {
			if (hasSeenInitialControllerSnapshot) setControllerRevision((revision) => revision + 1);
			else hasSeenInitialControllerSnapshot = true;
			update();
		});
		const markScrolling = () => {
			if (debugDisableScrollSuppressionRef.current === true) return;
			if (listElement != null) listElement.dataset.isScrolling ??= "";
			if (rootElement != null) rootElement.dataset.isScrolling ??= "";
			isScrollingRef.current = true;
			if (scrollTimer != null) clearTimeout(scrollTimer);
			scrollTimer = setTimeout(() => {
				if (listElement != null) delete listElement.dataset.isScrolling;
				if (rootElement != null) delete rootElement.dataset.isScrolling;
				isScrollingRef.current = false;
				setScrollSettledRevision((revision) => revision + 1);
				scrollTimer = null;
			}, 50);
		};
		let overlayRevealTimer = null;
		const clearOverlayReveal = () => {
			if (rootElement != null) delete rootElement.dataset.overlayReveal;
			if (overlayRevealTimer != null) {
				clearTimeout(overlayRevealTimer);
				overlayRevealTimer = null;
			}
		};
		const markOverlayReveal = () => {
			if (rootElement == null || debugDisableScrollSuppressionRef.current === true) return;
			if (scrollElement.scrollTop > 0) return;
			rootElement.dataset.overlayReveal = "true";
			if (overlayRevealTimer != null) clearTimeout(overlayRevealTimer);
			overlayRevealTimer = setTimeout(() => {
				clearOverlayReveal();
			}, 200);
		};
		const onScroll = () => {
			update();
			if (scrollElement.scrollTop > 0) clearOverlayReveal();
			if (contextMenuStateRef.current != null && isScrollingRef.current) closeContextMenuRef.current();
			if (debugDisableScrollSuppressionRef.current === true) {
				isScrollingRef.current = false;
				return;
			}
			setContextHoverPath((previousPath) => previousPath == null ? previousPath : null);
			markScrolling();
		};
		const onPreScroll = () => {
			markScrolling();
			markOverlayReveal();
		};
		const SCROLL_KEYS = new Set([
			"ArrowUp",
			"ArrowDown",
			"ArrowLeft",
			"ArrowRight",
			"PageUp",
			"PageDown",
			"Home",
			"End",
			" ",
			"Spacebar"
		]);
		const onKeyDownPreScroll = (event) => {
			if (!SCROLL_KEYS.has(event.key)) return;
			onPreScroll();
		};
		scrollElement.addEventListener("scroll", onScroll, { passive: true });
		scrollElement.addEventListener("wheel", onPreScroll, { passive: true });
		scrollElement.addEventListener("touchmove", onPreScroll, { passive: true });
		scrollElement.addEventListener("keydown", onKeyDownPreScroll);
		const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver((entries) => {
			measuredViewportHeightRef.current = (entries[0] == null ? null : getResizeObserverViewportHeight(entries[0])) ?? readMeasuredViewportHeight(scrollElement, initialViewportHeight);
			update();
		}) : null;
		resizeObserver?.observe(scrollElement);
		return () => {
			updateViewportRef.current = () => {};
			unsubscribe();
			scrollElement.removeEventListener("scroll", onScroll);
			scrollElement.removeEventListener("wheel", onPreScroll);
			scrollElement.removeEventListener("touchmove", onPreScroll);
			scrollElement.removeEventListener("keydown", onKeyDownPreScroll);
			if (scrollTimer != null) clearTimeout(scrollTimer);
			if (overlayRevealTimer != null) clearTimeout(overlayRevealTimer);
			if (listElement != null) delete listElement.dataset.isScrolling;
			if (rootElement != null) {
				delete rootElement.dataset.isScrolling;
				delete rootElement.dataset.overlayReveal;
			}
			isScrollingRef.current = false;
			measuredViewportHeightRef.current = null;
			resizeObserver?.disconnect();
		};
	}, [
		controller,
		initialViewportHeight,
		itemHeight,
		overscan,
		stickyFolders
	]);
	useLayoutEffect(() => {
		if (contextMenuEnabled || contextMenuState == null) return;
		closeContextMenu(false);
	}, [
		closeContextMenu,
		contextMenuEnabled,
		contextMenuState
	]);
	const activeContextMenuKey = useMemo(() => contextMenuState == null ? null : `${contextMenuState.path}::${contextMenuState.source}`, [contextMenuState]);
	useLayoutEffect(() => {
		if (activeContextMenuKey == null) {
			slotHost?.clearSlotContent(CONTEXT_MENU_SLOT_NAME);
			return;
		}
		const currentState = contextMenuStateRef.current;
		if (currentState == null) return;
		const anchorElement = contextMenuTriggerRef.current ?? contextMenuAnchorRef.current;
		if (anchorElement == null) return;
		const context = {
			anchorElement,
			anchorRect: currentState.anchorRect ?? serializeAnchorRect(anchorElement.getBoundingClientRect()),
			close: (options) => {
				closeContextMenuRef.current(options?.restoreFocus ?? true);
			},
			restoreFocus: () => {
				if (!shouldRestoreContextMenuFocusRef.current) return;
				restoreFocusToTreeRef.current(contextMenuStateRef.current?.path ?? null);
			}
		};
		const menuContent = composition?.contextMenu?.render?.(currentState.item, context) ?? null;
		slotHost?.setSlotContent(CONTEXT_MENU_SLOT_NAME, menuContent);
		composition?.contextMenu?.onOpen?.(currentState.item, context);
		focusFirstMenuElement(menuContent);
		queueMicrotask(() => {
			if (menuContent == null || !menuContent.isConnected) return;
			if (document.activeElement !== menuContent) return;
			focusFirstMenuElement(menuContent);
		});
		return () => {
			slotHost?.clearSlotContent(CONTEXT_MENU_SLOT_NAME);
		};
	}, [
		activeContextMenuKey,
		composition?.contextMenu,
		slotHost
	]);
	useLayoutEffect(() => {
		if (contextMenuState != null && controller.getItem(contextMenuState.path) == null) closeContextMenu();
	}, [
		closeContextMenu,
		contextMenuState,
		controller
	]);
	useLayoutEffect(() => {
		if (contextMenuState == null) return;
		const rootNode = rootRef.current?.getRootNode();
		const host = rootNode instanceof ShadowRoot ? rootNode.host : rootRef.current;
		const onPointerDown = (event) => {
			const target = event.target;
			if (!(target instanceof Node)) return;
			if (isEventInContextMenu(event)) return;
			if (contextMenuAnchorRef.current?.contains(target) === true) return;
			if (host?.contains(target) === true) return;
			closeContextMenu();
		};
		const onKeyDown = (event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				closeContextMenu();
			}
		};
		document.addEventListener("mousedown", onPointerDown, true);
		document.addEventListener("keydown", onKeyDown, true);
		return () => {
			document.removeEventListener("mousedown", onPointerDown, true);
			document.removeEventListener("keydown", onKeyDown, true);
		};
	}, [closeContextMenu, contextMenuState]);
	useLayoutEffect(() => {
		const scrollElement = scrollRef.current;
		const rootElement = rootRef.current;
		if (scrollElement == null || rootElement == null) {
			previousFocusedPathRef.current = focusedPath;
			return;
		}
		const focusedButton = focusedPath == null ? null : rowButtonRefs.current.get(focusedPath) ?? null;
		const activeTreeElement = getActiveTreeElement(rootElement);
		const activeTreeElementPath = activeTreeElement?.dataset.itemPath ?? null;
		const renameInputOwnsFocus = isRenaming && renameInputRef.current === activeTreeElement;
		const searchInputOwnsFocus = searchEnabled && searchInputRef.current === activeTreeElement;
		const shouldRestoreTreeFocusAfterSearchClose = restoreTreeFocusAfterSearchCloseRef.current && !isSearchOpen;
		const preservedViewportOffset = restoreTreeFocusViewportOffsetRef.current ?? 0;
		const pendingStickyFocusPath = pendingStickyFocusPathRef.current;
		const pendingStickyKeyboardFocusPath = pendingStickyKeyboardFocusPathRef.current;
		const pendingStickyKeyboardViewportOffset = pendingStickyKeyboardViewportOffsetRef.current;
		const pendingStickyKeyboardScrollTop = pendingStickyKeyboardScrollTopRef.current;
		const focusWithinTree = activeTreeElement != null;
		const shouldOwnDomFocus = domFocusOwnerRef.current || focusWithinTree;
		const focusedPathChanged = previousFocusedPathRef.current !== focusedPath;
		const shouldPreserveStickyKeyboardFocusViewport = pendingStickyKeyboardFocusPath != null && pendingStickyKeyboardFocusPath === focusedPath && focusedPath != null;
		let shouldSuppressDomFocusForScrollRequest = false;
		let shouldUpdateViewportForScrollRequest = false;
		if (scrollRequest != null && scrollRequest.id !== processedScrollRequestIdRef.current) {
			processedScrollRequestIdRef.current = scrollRequest.id;
			const scrollRequestIndex = scrollRequest.visibleIndex;
			const scrollRequestRow = controller.getVisibleRows(scrollRequestIndex, scrollRequestIndex)[0] ?? null;
			if (scrollRequestRow != null) {
				const scrollRequestTopInset = stickyFolders ? Math.max(0, Math.min(scrollRequestRow.ancestorPaths.length * itemHeight, Math.max(0, resolvedViewportHeight - itemHeight))) : stickyOverlayHeight;
				shouldSuppressDomFocusForScrollRequest = true;
				shouldUpdateViewportForScrollRequest = scrollFocusedRowToOffset(scrollElement, scrollRequestIndex, itemHeight, resolvedViewportHeight, totalScrollableHeight, scrollRequest.offset, scrollRequestTopInset);
			}
			controller.clearScrollRequest(scrollRequest.id);
		}
		const shouldRestoreFocusedRowViewportOffset = !shouldSuppressDomFocusForScrollRequest && shouldRestoreTreeFocusAfterSearchClose && scrollFocusedRowToViewportOffset(scrollElement, focusedIndex, itemHeight, resolvedViewportHeight, totalScrollableHeight, preservedViewportOffset);
		const shouldRestoreStickyFocusedRowViewportOffset = !shouldSuppressDomFocusForScrollRequest && pendingStickyFocusPath != null && pendingStickyFocusPath === focusedPath && scrollFocusedRowToViewportOffset(scrollElement, focusedIndex, itemHeight, resolvedViewportHeight, totalScrollableHeight, stickyOverlayHeight);
		const shouldRestoreStickyKeyboardViewportOffset = !shouldSuppressDomFocusForScrollRequest && pendingStickyKeyboardViewportOffset != null && pendingStickyKeyboardViewportOffset.path === focusedPath && scrollFocusedRowToViewportOffset(scrollElement, focusedIndex, itemHeight, resolvedViewportHeight, totalScrollableHeight, pendingStickyKeyboardViewportOffset.viewportOffset);
		const shouldRestoreStickyKeyboardScrollTop = !shouldSuppressDomFocusForScrollRequest && pendingStickyKeyboardScrollTop != null && pendingStickyKeyboardScrollTop.path === focusedPath && scrollElement.scrollTop !== pendingStickyKeyboardScrollTop.scrollTop;
		if (shouldRestoreStickyKeyboardScrollTop) scrollElement.scrollTop = pendingStickyKeyboardScrollTop.scrollTop;
		if (shouldRestoreStickyKeyboardScrollTop || shouldUpdateViewportForScrollRequest || shouldRestoreStickyFocusedRowViewportOffset || shouldRestoreStickyKeyboardViewportOffset || shouldRestoreFocusedRowViewportOffset || shouldOwnDomFocus && focusedPathChanged && pendingStickyFocusPath !== focusedPath && !shouldPreserveStickyKeyboardFocusViewport && scrollFocusedRowIntoView(scrollElement, focusedIndex, itemHeight, resolvedViewportHeight, stickyOverlayHeight)) updateViewportRef.current();
		if (shouldSuppressDomFocusForScrollRequest) {
			previousFocusedPathRef.current = focusedPath;
			return;
		}
		if (!shouldOwnDomFocus) {
			previousFocusedPathRef.current = focusedPath;
			return;
		}
		if (renameInputOwnsFocus) {
			previousFocusedPathRef.current = focusedPath;
			return;
		}
		if (searchInputOwnsFocus && !shouldRestoreTreeFocusAfterSearchClose) {
			previousFocusedPathRef.current = focusedPath;
			return;
		}
		if (focusedButton == null) {
			if (shouldRestoreTreeFocusAfterSearchClose && focusedIndex >= 0) {
				scrollFocusedRowToViewportOffset(scrollElement, focusedIndex, itemHeight, resolvedViewportHeight, totalScrollableHeight, preservedViewportOffset);
				updateViewportRef.current();
			}
			previousFocusedPathRef.current = focusedPath;
			return;
		}
		if (focusedPathChanged || shouldRestoreTreeFocusAfterSearchClose || pendingStickyFocusPath === focusedPath || pendingStickyKeyboardFocusPath === focusedPath || pendingStickyKeyboardViewportOffset?.path === focusedPath || pendingStickyKeyboardScrollTop?.path === focusedPath || activeTreeElementPath == null || activeTreeElementPath !== focusedPath) {
			focusElement(focusedButton);
			if (pendingStickyFocusPath === focusedPath) pendingStickyFocusPathRef.current = null;
			if (pendingStickyKeyboardFocusPath === focusedPath) pendingStickyKeyboardFocusPathRef.current = null;
			if (pendingStickyKeyboardViewportOffset?.path === focusedPath) pendingStickyKeyboardViewportOffsetRef.current = null;
			if (pendingStickyKeyboardScrollTop?.path === focusedPath) pendingStickyKeyboardScrollTopRef.current = null;
			restoreTreeFocusAfterSearchCloseRef.current = false;
			restoreTreeFocusViewportOffsetRef.current = null;
		}
		previousFocusedPathRef.current = focusedPath;
	}, [
		controller,
		focusedIndex,
		focusedPath,
		focusedRowIsMounted,
		itemHeight,
		isRenaming,
		isSearchOpen,
		range,
		resolvedViewportHeight,
		searchEnabled,
		scrollRequest,
		stickyFolders,
		stickyOverlayHeight,
		totalScrollableHeight,
		visibleRows
	]);
	const focusedRowIsVisible = focusedIndex >= 0 && focusedIndex >= layoutSnapshot.visible.startIndex && focusedIndex <= layoutSnapshot.visible.endIndex;
	const focusedRowIsSticky = focusedPath != null && stickyRows.some((entry) => getFileTreeRowPath(entry.row) === focusedPath);
	const focusedRowHasVisibleAnchor = focusedRowIsVisible || focusedRowIsSticky;
	const focusTriggerPath = contextMenuButtonTriggerEnabled && domFocusOwnerRef.current === true && focusedRowHasVisibleAnchor ? focusedPath : null;
	const pointerTriggerPath = lastContextMenuInteraction === "pointer" ? contextHoverPath : null;
	const triggerPath = contextMenuState?.path ?? debugContextMenuTriggerPathRef.current ?? pointerTriggerPath ?? focusTriggerPath ?? contextHoverPath;
	const isPointerContextMenuOpen = contextMenuState?.source === "right-click";
	useLayoutEffect(() => {
		if (isScrollingRef.current && contextMenuState == null) return;
		updateTriggerPosition(getTriggerAnchorButton(triggerPath));
	}, [
		contextMenuState,
		getTriggerAnchorButton,
		range,
		resolvedViewportHeight,
		scrollSettledRevision,
		stickyRows,
		triggerPath,
		updateTriggerPosition,
		visibleRows
	]);
	const handleTreePointerOver = useCallback((event) => {
		if (isScrollingRef.current) return;
		if (isEventInContextMenu(event)) return;
		const target = event.target;
		if (!(target instanceof HTMLElement)) return;
		if (target.closest?.(`[data-type="${CONTEXT_MENU_TRIGGER_TYPE}"]`) != null) return;
		const stickyRowButton = target.closest?.("[data-file-tree-sticky-row=\"true\"]");
		const rowButton = target.closest?.("[data-type=\"item\"]");
		const nextPath = stickyRowButton instanceof HTMLElement ? stickyRowButton.dataset.fileTreeStickyPath ?? null : rowButton instanceof HTMLElement ? rowButton.dataset.itemPath ?? null : null;
		if (nextPath != null) setLastContextMenuInteraction((previousMode) => previousMode === "pointer" ? previousMode : "pointer");
		setContextHoverPath((previousPath) => previousPath === nextPath ? previousPath : nextPath);
	}, []);
	const handleTreePointerLeave = useCallback(() => {
		setContextHoverPath(null);
	}, []);
	useLayoutEffect(() => {
		if (!dragAndDropEnabled) return;
		const handleWindowDragEnd = () => {
			clearTouchDragResources();
			controller.cancelDrag();
		};
		window.addEventListener("dragend", handleWindowDragEnd);
		return () => {
			window.removeEventListener("dragend", handleWindowDragEnd);
			clearTouchDragResources();
			controller.cancelDrag();
		};
	}, [controller, dragAndDropEnabled]);
	const handleTreeDragOver = (event) => {
		if (!dragAndDropEnabled || controller.getDragSession() == null || touchDragActiveRef.current) return;
		const nextTarget = resolveDropTargetFromElement(event.target instanceof HTMLElement ? event.target : null);
		controller.setDragTarget(nextTarget);
		scheduleDragHoverOpen(controller.getDragSession()?.target ?? null);
		updateDragPoint(event.clientX, event.clientY);
		if (event.dataTransfer != null) event.dataTransfer.dropEffect = "move";
		event.preventDefault();
	};
	const handleTreeDragLeave = (event) => {
		if (!dragAndDropEnabled || controller.getDragSession() == null || touchDragActiveRef.current) return;
		const nextTarget = event.relatedTarget;
		if (nextTarget instanceof Node && rootRef.current?.contains(nextTarget) === true) return;
		clearDragHoverOpen();
		stopDragAutoScroll();
		controller.setDragTarget(null);
	};
	const handleTreeDrop = (event) => {
		if (!dragAndDropEnabled || controller.getDragSession() == null || touchDragActiveRef.current) return;
		event.preventDefault();
		syncDropTargetFromPoint(event.clientX, event.clientY);
		controller.completeDrag();
		clearDragPreview();
		clearDragHoverOpen();
		stopDragAutoScroll();
		dragRowSnapshotRef.current = null;
	};
	const windowHeight = layoutSnapshot.window.height;
	const windowOffsetTop = layoutSnapshot.window.offsetTop;
	const windowStickyTopInset = Math.min(0, resolvedViewportHeight - windowHeight);
	const windowStickyBottomInset = Math.min(0, resolvedViewportHeight - windowHeight - stickyOverlayHeight);
	const shouldRenderParkedFocusedRow = activeItemPath === focusedPath || restoreTreeFocusAfterSearchCloseRef.current;
	const parkedFocusedRow = focusedPath != null && shouldRenderParkedFocusedRow && !focusedRowIsMounted && focusedIndex >= 0 ? visibleRows[focusedIndex] ?? controller.getVisibleRows(focusedIndex, focusedIndex)[0] ?? null : null;
	const parkedFocusedRowOffset = parkedFocusedRow == null ? null : getParkedFocusedRowOffset(focusedIndex, itemHeight, range, windowHeight);
	const draggedRowSnapshot = dragRowSnapshotRef.current;
	const draggedRowIsMounted = draggedPrimaryPath != null && draggedRowSnapshot != null && draggedRowSnapshot.path === draggedPrimaryPath && draggedRowSnapshot.index >= range.start && draggedRowSnapshot.index <= range.end;
	const parkedDraggedRow = draggedPrimaryPath != null && draggedRowSnapshot != null && draggedRowSnapshot.path === draggedPrimaryPath && !draggedRowIsMounted && draggedRowSnapshot.path !== parkedFocusedRow?.path ? draggedRowSnapshot : null;
	const parkedDraggedRowOffset = parkedDraggedRow == null ? null : getParkedFocusedRowOffset(parkedDraggedRow.index, itemHeight, range, windowHeight);
	const guideStyleText = getFileTreeGuideStyleText((focusedIndex >= 0 ? visibleRows[focusedIndex] ?? controller.getVisibleRows(focusedIndex, focusedIndex)[0] ?? null : null)?.ancestorPaths.at(-1) ?? null);
	const activeDescendantId = isSearchOpen && focusedPath != null ? getFileTreeFocusedRowDomId(instanceId, focusedPath, !focusedRowIsMounted) : void 0;
	const visualFocusPath = contextMenuState?.path ?? (isSearchOpen ? focusedPath : activeItemPath);
	const visualContextHoverPath = contextMenuState?.path ?? contextHoverPath;
	const triggerButton = getTriggerAnchorButton(triggerPath);
	const triggerButtonVisible = contextMenuEnabled && contextMenuButtonTriggerEnabled && !isPointerContextMenuOpen && !isRenaming && triggerButton != null && contextMenuAnchorTop != null && triggerPath != null;
	const contextMenuAnchorVisible = contextMenuEnabled && (triggerButtonVisible || contextMenuState != null);
	const pointerAnchorRect = contextMenuState?.anchorRect;
	const rowAnchorTop = pointerAnchorRect == null && triggerButton != null && contextMenuAnchorTop != null && (contextMenuState != null || triggerButtonVisible) ? contextMenuAnchorTop : null;
	const contextMenuAnchorStyle = pointerAnchorRect != null ? {
		left: `${pointerAnchorRect.left}px`,
		position: "fixed",
		right: "auto",
		top: `${pointerAnchorRect.top}px`
	} : rowAnchorTop != null ? { top: `${rowAnchorTop}px` } : void 0;
	const contextMenuTriggerStyle = isPointerContextMenuOpen ? { opacity: "0" } : void 0;
	const handleRowClick = useCallback((event, row, targetPath, mode) => {
		const plan = computeFileTreeRowClickPlan({
			event: {
				ctrlKey: event.ctrlKey,
				metaKey: event.metaKey,
				shiftKey: event.shiftKey
			},
			isDirectory: row.kind === "directory",
			isSearchOpen,
			mode
		});
		const shouldToggleDirectory = plan.toggleDirectory && row.kind === "directory";
		const mountedDirectoryPath = shouldToggleDirectory ? controller.resolveMountedDirectoryPathFromInput(targetPath) : null;
		if (shouldToggleDirectory && mountedDirectoryPath == null) return;
		const actionTargetPath = mountedDirectoryPath ?? targetPath;
		switch (plan.selection.kind) {
			case "range":
				controller.selectPathRange(actionTargetPath, plan.selection.additive);
				break;
			case "toggle":
				controller.togglePathSelectionFromInput(actionTargetPath);
				break;
			case "single":
				controller.selectOnlyMountedPathFromInput(actionTargetPath);
				break;
		}
		const clickedElement = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
		const clickedRowIsVisible = row.index >= layoutSnapshot.visible.startIndex && row.index <= layoutSnapshot.visible.endIndex;
		const shouldExposeFocusedTrigger = mode === "flow" && clickedRowIsVisible && clickedElement != null && clickedElement.dataset.itemParked !== "true";
		controller.focusMountedPathFromInput(actionTargetPath);
		if (shouldExposeFocusedTrigger) {
			domFocusOwnerRef.current = true;
			setActiveItemPath((previousPath) => previousPath === actionTargetPath ? previousPath : actionTargetPath);
			setLastContextMenuInteraction("focus");
		}
		if (shouldToggleDirectory) controller.toggleMountedDirectoryFromInput(actionTargetPath);
		if (plan.closeSearch) controller.closeSearch();
		if (plan.revealCanonical) revealCanonicalRowAtStickyOffset(actionTargetPath, { targetOffset: "sticky-parents" });
	}, [
		controller,
		isSearchOpen,
		layoutSnapshot.visible.endIndex,
		layoutSnapshot.visible.startIndex,
		revealCanonicalRowAtStickyOffset
	]);
	const openMenuFromTrigger = () => {
		if (isScrollingRef.current) return;
		if (!contextMenuButtonTriggerEnabled) return;
		if (triggerPath == null || triggerButton == null) return;
		const triggerItem = controller.getItem(triggerPath);
		if (triggerItem == null) return;
		updateTriggerPosition(triggerButton);
		shouldRestoreContextMenuFocusRef.current = true;
		setContextMenuState({
			anchorRect: null,
			item: {
				kind: triggerItem.isDirectory() ? "directory" : "file",
				name: triggerButton.getAttribute("aria-label") ?? triggerPath,
				path: triggerItem.getPath()
			},
			path: triggerItem.getPath(),
			source: "button"
		});
	};
	const flowRowFrame = {
		contextHoverPath: visualContextHoverPath,
		contextMenuButtonTriggerEnabled,
		contextMenuButtonVisibility,
		contextMenuEnabled,
		contextMenuRightClickEnabled,
		contextMenuTriggerMode,
		controller,
		directoriesWithGitChanges,
		dragAndDropEnabled,
		draggedPathSet,
		dragTarget,
		gitLaneActive,
		gitStatusByPath,
		handleRowDragEnd,
		handleRowDragStart,
		handleRowTouchStart,
		ignoredGitDirectories,
		ignoredInheritanceCache,
		instanceId,
		itemHeight,
		onKeyDown: handleTreeKeyDown,
		onRowClick: handleRowClick,
		openContextMenuForRow,
		registerButton: registerRowButton,
		registerRenameInput,
		renameView,
		renderDecorationForRow,
		resolveIcon,
		shouldSuppressContextMenu,
		visualFocusPath
	};
	const stickyRowFrame = {
		...flowRowFrame,
		registerButton: registerStickyRowButton
	};
	return /* @__PURE__ */ jsxs("div", {
		ref: rootRef,
		id: treeDomId,
		"data-file-tree-context-menu-button-visibility": contextMenuEnabled && contextMenuButtonTriggerEnabled ? contextMenuButtonVisibility : void 0,
		"data-file-tree-context-menu-trigger-mode": contextMenuEnabled ? contextMenuTriggerMode : void 0,
		"data-file-tree-has-context-menu-action-lane": contextMenuEnabled && contextMenuButtonTriggerEnabled ? "true" : void 0,
		"data-file-tree-has-git-lane": gitLaneActive ? "true" : void 0,
		"data-file-tree-virtualized-root": "true",
		onDragLeave: dragAndDropEnabled ? handleTreeDragLeave : void 0,
		onDragOver: dragAndDropEnabled ? handleTreeDragOver : void 0,
		onDrop: dragAndDropEnabled ? handleTreeDrop : void 0,
		onKeyDown: handleTreeKeyDown,
		onPointerLeave: contextMenuEnabled ? handleTreePointerLeave : void 0,
		onPointerOver: contextMenuEnabled ? handleTreePointerOver : void 0,
		role: "tree",
		tabIndex: -1,
		style: {
			outline: "none",
			position: "relative"
		},
		children: [
			/* @__PURE__ */ jsx("style", {
				"data-file-tree-guide-style": "true",
				dangerouslySetInnerHTML: { __html: guideStyleText }
			}),
			/* @__PURE__ */ jsx("slot", {
				name: HEADER_SLOT_NAME,
				"data-type": "header-slot"
			}),
			searchEnabled ? /* @__PURE__ */ jsx("div", {
				"data-file-tree-search-container": true,
				"data-open": isSearchOpen ? "true" : "false",
				children: /* @__PURE__ */ jsx("input", {
					ref: searchInputRef,
					"aria-activedescendant": activeDescendantId,
					"aria-controls": treeDomId,
					placeholder: "Search…",
					"data-file-tree-search-input": true,
					"data-file-tree-search-input-fake-focus": fakeSearchFocusActive ? "true" : void 0,
					value: searchValue,
					onBlur: () => {
						if (searchBlurBehavior === "retain" && !searchInputUserInteractedRef.current) return;
						controller.closeSearch();
					},
					onFocus: markSearchInputInteracted,
					onPointerDown: markSearchInputInteracted,
					onInput: (event) => {
						markSearchInputInteracted();
						const target = event.currentTarget;
						controller.setSearch(target.value);
					}
				})
			}) : null,
			/* @__PURE__ */ jsxs("div", {
				ref: scrollRef,
				"data-file-tree-virtualized-scroll": "true",
				children: [stickyFolders && hasStickyUiMount && stickyRows.length > 0 ? /* @__PURE__ */ jsx("div", {
					"aria-hidden": "true",
					"data-file-tree-sticky-overlay": "true",
					children: /* @__PURE__ */ jsx("div", {
						"data-file-tree-sticky-overlay-content": "true",
						style: { height: `${overlayRowsHeight}px` },
						children: stickyRows.map((entry, index) => renderStyledRow(stickyRowFrame, entry.row, `sticky:${getFileTreeRowPath(entry.row)}`, {
							mode: "sticky",
							style: {
								left: "0",
								position: "absolute",
								right: "0",
								top: `${entry.top}px`,
								zIndex: `${stickyRows.length - index}`
							}
						}))
					})
				}) : null, /* @__PURE__ */ jsxs("div", {
					ref: listRef,
					"data-file-tree-virtualized-list": "true",
					style: { height: `${totalScrollableHeight}px` },
					children: [/* @__PURE__ */ jsx("div", {
						"data-file-tree-virtualized-sticky-offset": "true",
						"aria-hidden": "true",
						style: { height: `${windowOffsetTop}px` }
					}), /* @__PURE__ */ jsxs("div", {
						"data-file-tree-virtualized-sticky": "true",
						style: {
							height: `${windowHeight}px`,
							top: `${windowStickyTopInset}px`,
							bottom: `${windowStickyBottomInset}px`
						},
						children: [
							renderRangeChildren(flowRowFrame, range, stickyRowPathSet),
							parkedFocusedRow != null && parkedFocusedRowOffset != null ? renderStyledRow(flowRowFrame, parkedFocusedRow, `parked:${parkedFocusedRow.path}`, {
								isParked: true,
								style: {
									left: "0",
									opacity: "0",
									pointerEvents: draggedPrimaryPath === parkedFocusedRow.path ? "none" : void 0,
									position: "absolute",
									right: "0",
									top: `${parkedFocusedRowOffset}px`
								}
							}) : null,
							parkedDraggedRow != null && parkedDraggedRowOffset != null ? renderStyledRow(flowRowFrame, parkedDraggedRow, `parked-drag:${parkedDraggedRow.path}`, {
								isParked: true,
								style: {
									left: "0",
									opacity: "0",
									pointerEvents: "none",
									position: "absolute",
									right: "0",
									top: `${parkedDraggedRowOffset}px`
								}
							}) : null
						]
					})]
				})]
			}),
			contextMenuEnabled ? /* @__PURE__ */ jsxs("div", {
				ref: contextMenuAnchorRef,
				"data-type": "context-menu-anchor",
				"data-visible": contextMenuAnchorVisible ? "true" : "false",
				style: contextMenuAnchorStyle,
				children: [/* @__PURE__ */ jsx("button", {
					ref: contextMenuTriggerRef,
					type: "button",
					"data-type": CONTEXT_MENU_TRIGGER_TYPE,
					"aria-label": "Options",
					"aria-haspopup": "menu",
					"aria-expanded": contextMenuState != null ? "true" : "false",
					"data-visible": triggerButtonVisible ? "true" : "false",
					onMouseDown: (event) => {
						event.preventDefault();
					},
					onClick: (event) => {
						event.preventDefault();
						event.stopPropagation();
						if (contextMenuState != null) {
							closeContextMenu();
							return;
						}
						openMenuFromTrigger();
					},
					tabIndex: -1,
					style: contextMenuTriggerStyle,
					children: /* @__PURE__ */ jsx(Icon, { ...resolveIcon("file-tree-icon-ellipsis") })
				}), contextMenuState != null ? /* @__PURE__ */ jsx("slot", { name: CONTEXT_MENU_SLOT_NAME }) : null]
			}) : null,
			contextMenuState != null ? /* @__PURE__ */ jsx("div", {
				"data-type": "context-menu-wash",
				"aria-hidden": "true",
				onMouseDownCapture: (event) => {
					event.preventDefault();
					closeContextMenu();
				},
				onTouchStartCapture: (event) => {
					event.preventDefault();
					event.stopPropagation();
					closeContextMenu();
				},
				onTouchMoveCapture: (event) => {
					event.preventDefault();
					event.stopPropagation();
				},
				onWheelCapture: (event) => {
					event.preventDefault();
					event.stopPropagation();
				}
			}) : null
		]
	});
}

//#endregion
export { FileTreeView };
//# sourceMappingURL=FileTreeView.js.map