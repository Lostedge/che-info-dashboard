"""
SQL 查询
"""

# 堆场设备作业统计（RTG、FL、RS）
YM_STATS = """
    SELECT
        SUBSTR(CY_MACH_NO, -3)                                         AS id,
        COUNT(CASE WHEN CNTR_SIZ_COD = '20' THEN 1 END)                AS day_20,
        COUNT(CASE WHEN CNTR_SIZ_COD = '40' THEN 1 END)                AS day_40,
        COUNT(CASE WHEN CNTR_SIZ_COD = '20'
                   AND WORK_TIM >= :period_start THEN 1 END)           AS period_20,
        COUNT(CASE WHEN CNTR_SIZ_COD = '40'
                   AND WORK_TIM >= :period_start THEN 1 END)           AS period_40
    FROM JZCT_TOS_HIS.CY_COMMAND
    WHERE WORK_TIM IS NOT NULL
      AND WORK_TIM >= :day_start
      AND WORK_TIM <  :period_end
      AND CY_MACH_NO IS NOT NULL
      AND QUEUE_TYP IN ('SI','SO','TI','TO')
    GROUP BY CY_MACH_NO
    ORDER BY CY_MACH_NO
"""

# 岸桥作业统计
QC_STATS = """
    SELECT
        SUBSTR(SHIP_MACH_NO, -3)                                       AS id,
        COUNT(CASE WHEN CNTR_SIZ_COD = '20' THEN 1 END)                AS day_20,
        COUNT(CASE WHEN CNTR_SIZ_COD = '40' THEN 1 END)                AS day_40,
        COUNT(CASE WHEN CNTR_SIZ_COD = '20'
                   AND WORK_TIM >= :period_start THEN 1 END)           AS period_20,
        COUNT(CASE WHEN CNTR_SIZ_COD = '40'
                   AND WORK_TIM >= :period_start THEN 1 END)           AS period_40
    FROM JZCT_TOS_HIS.SHIP_COMMAND
    WHERE WORK_TIM IS NOT NULL
      AND WORK_TIM >= :day_start
      AND WORK_TIM <  :period_end
      AND SHIP_MACH_NO IS NOT NULL
    GROUP BY SHIP_MACH_NO
    ORDER BY SHIP_MACH_NO
"""

# 堆场设备信息（RTG、FL；FL 附位置 area/bay；附作业航次 voyage）
# 来源：VV_YE_BIND（装船绑定）优先，未绑定时回退近 :voyage_window 分钟内的 SI 指令（卸船）
#   TOS 只为装船分配设备，故 cmd 分支实际只服务卸船，两来源不会冲突
# 输出 voyage_src = 'bind' | 'cmd' | ''，显示策略由前端 config.ship_device_src 决定
YM_INFO = """
    SELECT
        SUBSTR(p.MACH_NO, -3)                       AS id,
        p.CURRENT_ID                                AS status,
        COALESCE(o.OPER_NAM, p.MACH_OPER_COD)       AS driver,
        p.WORK_WAY                                  AS work_way,
        CASE WHEN p.MACH_NO LIKE 'DGJ%'
             THEN p.CUR_CY_AREA_NO END              AS area,
        CASE WHEN p.MACH_NO LIKE 'DGJ%'
             THEN p.CUR_CY_BAY_NO  END              AS bay,
        COALESCE(b.VSL_VISIT_GKEY, s.VOYAGE_NO)     AS voyage,
        CASE WHEN b.VSL_VISIT_GKEY IS NOT NULL THEN 'bind'
             WHEN s.VOYAGE_NO      IS NOT NULL THEN 'cmd'
             ELSE '' END                            AS voyage_src
    FROM JZCT_TOS.CY_MACH_PLAC p
    LEFT JOIN JZCT_CODE.C_OPERATOR o ON o.OPER_COD = p.MACH_OPER_COD
    LEFT JOIN JZCT_CONDA.VV_YE_BIND b ON b.EQP_ID  = p.MACH_NO
    LEFT JOIN (
        SELECT CY_MACH_NO,
               MAX(TOOL_NO) KEEP (DENSE_RANK LAST ORDER BY WORK_TIM) AS ship_no
        FROM JZCT_TOS.CY_COMMAND
        WHERE WORK_TIM >= SYSDATE - :voyage_window / 1440
          AND QUEUE_TYP = 'SI'                     -- 仅卸船；装船由绑定表覆盖
          AND TOOL_NO IS NOT NULL
        GROUP BY CY_MACH_NO
    ) l ON l.CY_MACH_NO = p.MACH_NO
    LEFT JOIN JZCT_TOS_HIS.SHIP s ON s.SHIP_NO = l.ship_no
    WHERE p.MACH_NO LIKE 'CQ%'
       OR p.MACH_NO LIKE 'DGJ%'
"""

# 岸桥设备信息
QC_INFO = """
    SELECT
        SUBSTR(p.MACH_NO, -3)                       AS id,
        p.CURRENT_ID                                AS status,
        COALESCE(o.OPER_NAM, p.MACH_OPER_COD)       AS driver,
        COALESCE(v.SHIP_NAM, p.VOYAGE_NO)           AS ship_name,
        p.VOYAGE_NO                                 AS voyage,
        p.WORK_WAY                                  AS work_way,
        p.CUR_BAY_NO                                AS bay
    FROM JZCT_TOS.SHIP_MACH_PLAC p
    LEFT JOIN JZCT_CODE.C_OPERATOR o ON p.MACH_OPER_COD = o.OPER_COD
    LEFT JOIN JZCT_TOS_HIS.SHIP_VOYAGE v ON p.VOYAGE_NO = v.VOYAGE_NO
    WHERE p.MACH_NO IN ('AQ101','AQ102','AQ103','AQ104','AQ105','AQ106')
"""

# 船舶信息
SHIP_INFO = """
    SELECT
        p.VOYAGE_NO                                             AS id,
        p.SHIP_STAT_ID                                          AS status,
        p.SHIP_NAM                                              AS ship_name,
        COALESCE(p.I_VOYAGE, '-') 
            || '/' 
            || COALESCE(p.E_VOYAGE, '-')                        AS voyage,
        p.BERTH_COD                                             AS berth,
        p.ETA                                                   AS eta,
        p.RTB                                                   AS rtb,
        p.BEG_WORK_TIM                                          AS beg_work_tim
    FROM JZCT_TOS_HIS.SHIP_VOYAGE p
    WHERE (p.SHIP_STAT_ID IN ('Y', 'C', 'D')
        OR (p.SHIP_STAT_ID = 'E'
            AND p.ETA >= SYSDATE
            AND p.ETA <  SYSDATE + INTERVAL '1' DAY))
"""

# 船舶作业进度
SHIP_PROGRESS = """
    SELECT
        s.VOYAGE_NO                                                         AS id,
        COUNT(CASE WHEN v.I_E_ID = 'I' THEN 1 END)                          AS i_plan_num,
        COUNT(CASE WHEN v.I_E_ID = 'I'
                   AND v.WORK_TIM IS NOT NULL THEN 1 END)                   AS i_done_num,
        COUNT(CASE WHEN v.I_E_ID = 'I'
                   AND v.COMM_STATUS IS NOT NULL THEN 1 END)                AS i_queue_num,
        COUNT(CASE WHEN v.I_E_ID = 'E' THEN 1 END)                          AS e_plan_num,
        COUNT(CASE WHEN v.I_E_ID = 'E'
                   AND v.WORK_TIM IS NOT NULL THEN 1 END)                   AS e_done_num,
        COUNT(CASE WHEN v.I_E_ID = 'E'
                   AND v.COMM_STATUS IS NOT NULL THEN 1 END)                AS e_queue_num
    FROM JZCT_TOS_HIS.SHIP s
    LEFT JOIN JZCT_TOS.V_SAS_SHIP_MONITOR_QRY v ON s.SHIP_NO = v.SHIP_NO
    WHERE s.VOYAGE_NO IN ({voyages})
    GROUP BY s.VOYAGE_NO
"""

# 岸桥 move 数：按整点小时桶统计
# 双吊 = 相邻两行（同一岸桥，按 WORK_TIM 排序）间隔 <30s 且同车号且都是 20 尺，合并计 1 move；其余每行计 1
# 预读窗口必须 >= 下面的 30s 阈值，否则窗口首行会被误判为新 move
QC_MOVE_HOUR = """
    SELECT id, voyage, bucket, SUM(is_new) AS moves
    FROM (
        SELECT SUBSTR(w.SHIP_MACH_NO, -3)                               AS id,
               s.VOYAGE_NO                                              AS voyage,
               TO_CHAR(TRUNC(w.WORK_TIM, 'HH24'), 'YYYY-MM-DD HH24:MI')  AS bucket,
               CASE WHEN w.prev_tim IS NULL
                      OR (w.WORK_TIM - w.prev_tim) * 86400 >= 30        -- 间隔 ≥30s → 新 move
                      OR NVL(w.TRUCK_NO, '~') <> NVL(w.prev_trk, '~')   -- 车号不同 → 新 move
                      OR w.CNTR_SIZ_COD <> '20'                         -- 非双 20 → 新 move
                      OR w.prev_siz <> '20'
                    THEN 1 ELSE 0 END                                   AS is_new
        FROM (
            SELECT SHIP_MACH_NO, SHIP_NO, WORK_TIM, TRUCK_NO, CNTR_SIZ_COD,
                   LAG(WORK_TIM)     OVER (PARTITION BY SHIP_MACH_NO
                                           ORDER BY WORK_TIM, TRUCK_NO, CNTR) AS prev_tim,
                   LAG(TRUCK_NO)     OVER (PARTITION BY SHIP_MACH_NO
                                           ORDER BY WORK_TIM, TRUCK_NO, CNTR) AS prev_trk,
                   LAG(CNTR_SIZ_COD) OVER (PARTITION BY SHIP_MACH_NO
                                           ORDER BY WORK_TIM, TRUCK_NO, CNTR) AS prev_siz
            FROM JZCT_TOS_HIS.SHIP_COMMAND
            WHERE WORK_TIM >= :win_start - INTERVAL '1' MINUTE            -- 预读，仅供 LAG
              AND WORK_TIM <  :win_end
              AND SHIP_MACH_NO IN ('AQ101','AQ102','AQ103','AQ104','AQ105','AQ106')
        ) w
        LEFT JOIN JZCT_TOS_HIS.SHIP s ON s.SHIP_NO = w.SHIP_NO
        WHERE w.WORK_TIM >= :win_start                                    -- 只统计目标窗口
    )
    GROUP BY id, voyage, bucket
    ORDER BY id, voyage, bucket
"""

# 查询某航次装船箱分布：按 场区/卸港/空重/尺寸 统计
# voyage → 出口航次 SHIP_NO（E）→ 该船号下的在场箱 ∩ 视图成员（ship_baplie / ship_ncl）
SHIP_CNTR_SUM = """
    SELECT g.disc_port,
           NVL(p.C_PORT_NAM, g.disc_port)   AS port_nam,
           g.ef,
           g.siz,
           g.area,
           g.cnt
    FROM (
        SELECT NVL(c.DISC_PORT_COD, '-')    AS disc_port,
               NVL(c.E_F_ID, '-')           AS ef,
               c.CNTR_SIZ_COD               AS siz,
               NVL(c.CY_AREA_NO, '-')       AS area,
               COUNT(*)                     AS cnt
        FROM JZCT_TOS.PORT_CNTR c
        WHERE c.SHIP_NO IN (
                SELECT s.SHIP_NO
                FROM JZCT_TOS_HIS.SHIP s
                WHERE s.VOYAGE_NO IN ({voyages})
                  AND s.I_E_ID = 'E'
            )
          AND (EXISTS (
                    SELECT 1
                    FROM JZCT_TOS.SHIP_BAPLIE a
                    WHERE a.ship_no = c.ship_no
                      AND a.cntr = c.cntr
                      AND a.cntr_class IN ('I', 'T')
                      AND NVL(a.miss_id, '0') <> '1'
                )
            OR EXISTS (
                    SELECT 1
                    FROM JZCT_TOS.SHIP_NCL a
                    WHERE a.ship_no = c.ship_no
                      AND a.cntr = c.cntr
                      AND a.cntr_class IN ('E', 'T')
                      AND NVL(a.exit_custom_id, '0') = '0'
                ))
        GROUP BY NVL(c.DISC_PORT_COD, '-'),
                 NVL(c.E_F_ID, '-'),
                 c.CNTR_SIZ_COD,
                 NVL(c.CY_AREA_NO, '-')
    ) g
    LEFT JOIN JZCT_CODE.C_PORT p ON p.PORT_COD = g.disc_port
    ORDER BY g.area, g.disc_port, g.ef, g.siz
"""

# ============================================================
# 当班统计：换班检测
# ============================================================

# 堆场设备换班检测+补偿：返回换司机设备的 id/当班起点，及 [换班点, 检测点) 的 20/40 补偿量
SHIFT_DETECT_CY = """
    SELECT SUBSTR(CY_MACH_NO, -3)                                AS id,
           MAX(shift_start)                                      AS shift_start,
           COUNT(CASE WHEN CNTR_SIZ_COD = '20' THEN 1 END)       AS comp_20,
           COUNT(CASE WHEN CNTR_SIZ_COD = '40' THEN 1 END)       AS comp_40
    FROM (
        SELECT CY_MACH_NO, CNTR_SIZ_COD, WORK_TIM,
               MAX(CASE WHEN is_switch = 1 THEN WORK_TIM END)
                   OVER (PARTITION BY CY_MACH_NO)                AS shift_start
        FROM (
            SELECT CY_MACH_NO, CNTR_SIZ_COD, WORK_TIM,
                   CASE WHEN prev_nam IS NOT NULL AND prev_nam <> REPLACE_NAM
                        THEN 1 ELSE 0 END                        AS is_switch
            FROM (
                SELECT CY_MACH_NO, CNTR_SIZ_COD, WORK_TIM, REPLACE_NAM,
                       LAG(REPLACE_NAM) OVER (PARTITION BY CY_MACH_NO ORDER BY WORK_TIM) AS prev_nam
                FROM JZCT_TOS_HIS.CY_COMMAND
                WHERE WORK_TIM >= :lookback
                  AND WORK_TIM <  :check_time
                  AND CY_MACH_NO IS NOT NULL
            )
        )
    )
    WHERE WORK_TIM >= shift_start
    GROUP BY SUBSTR(CY_MACH_NO, -3)
"""

# 岸桥换班检测+补偿
SHIFT_DETECT_QC = """
    SELECT SUBSTR(SHIP_MACH_NO, -3)                              AS id,
           MAX(shift_start)                                      AS shift_start,
           COUNT(CASE WHEN CNTR_SIZ_COD = '20' THEN 1 END)       AS comp_20,
           COUNT(CASE WHEN CNTR_SIZ_COD = '40' THEN 1 END)       AS comp_40
    FROM (
        SELECT SHIP_MACH_NO, CNTR_SIZ_COD, WORK_TIM,
               MAX(CASE WHEN is_switch = 1 THEN WORK_TIM END)
                   OVER (PARTITION BY SHIP_MACH_NO)              AS shift_start
        FROM (
            SELECT SHIP_MACH_NO, CNTR_SIZ_COD, WORK_TIM,
                   CASE WHEN prev_nam IS NOT NULL AND prev_nam <> SHIP_MACH_DRIVER
                        THEN 1 ELSE 0 END                        AS is_switch
            FROM (
                SELECT SHIP_MACH_NO, CNTR_SIZ_COD, WORK_TIM, SHIP_MACH_DRIVER,
                       LAG(SHIP_MACH_DRIVER) OVER (PARTITION BY SHIP_MACH_NO ORDER BY WORK_TIM) AS prev_nam
                FROM JZCT_TOS_HIS.SHIP_COMMAND
                WHERE WORK_TIM >= :lookback
                  AND WORK_TIM <  :check_time
                  AND SHIP_MACH_NO IS NOT NULL
            )
        )
    )
    WHERE WORK_TIM >= shift_start
    GROUP BY SUBSTR(SHIP_MACH_NO, -3)
"""
