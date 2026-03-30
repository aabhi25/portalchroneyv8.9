interface QuickBrowseButton {
  label: string;
  action: string;
}

interface QuickBrowseButtonsProps {
  buttons: QuickBrowseButton[];
  onSelect: (action: string) => void;
  chatColor?: string;
  chatColorEnd?: string;
}

export function QuickBrowseButtons({ 
  buttons, 
  onSelect,
  chatColor = "#9333ea",
  chatColorEnd = "#3b82f6"
}: QuickBrowseButtonsProps) {
  if (!buttons || buttons.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 my-3 px-1">
      {buttons.map((button, index) => (
        <button
          key={index}
          onClick={() => onSelect(button.action)}
          className="group relative px-3 py-1.5 text-sm font-medium rounded-full border-2 transition-all duration-200 hover:scale-105 active:scale-95"
          style={{
            borderColor: chatColor,
            color: chatColor,
            background: 'transparent'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = `linear-gradient(135deg, ${chatColor}, ${chatColorEnd})`;
            e.currentTarget.style.color = 'white';
            e.currentTarget.style.borderColor = 'transparent';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = chatColor;
            e.currentTarget.style.borderColor = chatColor;
          }}
        >
          {button.label}
        </button>
      ))}
    </div>
  );
}
